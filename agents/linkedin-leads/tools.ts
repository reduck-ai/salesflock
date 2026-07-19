// The tools that earn a TS layer — they do what `reduck run` alone can't: fetch a
// LinkedIn entity and write it to the CRM, or set up a Lead by joining two records that
// are already there. Fetch + compose lives in the Lk client; the record mapping — the
// one model-specific bit — lives here, then goes to the store's upsert directly.

import {
	searchProfiles as lkSearchProfiles,
	getProfile as lkGetProfile,
	getCompany as lkGetCompany,
	publicIdOf
} from "../../src/clients/lk/index.js";
import { getStore } from "../../src/stores/index.js";
import { reviewOf } from "../../src/review.js";
import * as llm from "../../src/ai/llm.js";
import { resolveQuotes, validate, type RawStatement, type Statement } from "../../src/anchor.js";
import { markdown } from "../../src/markdown.js";
import { Ajv } from "ajv";
import { stringify } from "yaml";
import config from "./config.js";
import type { People } from "./schema/People.js";
import type { Companies } from "./schema/Companies.js";
import type { Leads } from "./schema/Leads.js";
import type { Sourcing } from "./schema/Sourcing.js";
import type { Decisions } from "./schema/Decisions.js";

// The store this agent writes to and the tables it addresses — both chosen in config.ts
// (notion by default). No env: the model→table map and prompt specs all live in one file.
const store = getStore(config.destination);

// The decision kinds this agent can produce — the keys of config.prompts.
type PromptKey = keyof typeof config.prompts;

// A LinkedIn company's headquarters → a one-line HQ string, or undefined if it has none.
const hq = (
	h:
		| { city?: string | null; geographicArea?: string | null; country?: string | null }
		| null
		| undefined
) => (h && [h.city, h.geographicArea, h.country].filter(Boolean).join(", ")) || undefined;

// The judge's response envelope: the domain `output` — its shape declared by the Prompt's
// Output schema — plus `statements`, the fixed claim→evidence anchoring layer every evidenced
// judgment carries. The verbatim-quote contract lives here, in code, not in the per-agent prompt.
const STATEMENTS = {
	type: "array",
	description:
		"reasoning as claim→proof: one entry per point that decided the verdict, covering both " +
		"what supports it and what cuts against it",
	items: {
		type: "object",
		required: ["claim", "supporting", "quotes"],
		properties: {
			claim: {
				type: "string",
				description: "one short sentence tying the evidence to a criterion"
			},
			supporting: {
				type: "boolean",
				description:
					"true if this point argues FOR qualifying the lead, false if it argues against"
			},
			quotes: {
				type: "array",
				minItems: 1,
				items: { type: "string" },
				description:
					"the exact text from the Evidence backing the claim, copied verbatim — character-for-character substrings, " +
					"no paraphrase, no ellipses; the shortest that proves the point, one per distinct proof. " +
					"Every claim needs at least one quote — a point the evidence can't back is not a statement."
			}
		}
	}
} as const;

const ajv = new Ajv();

// A judgment, whoever judged: the domain output plus its claim→proof statements. What
// the LLM returns, and what a manual judge hands to `qualify` via --verdict.
export interface Verdict {
	output: Record<string, unknown>;
	statements: RawStatement[];
}

// The judgment context: the Prompt row's full contract plus the Person's frozen evidence —
// everything a judge needs, nothing written. Both judges read the exact same context:
// the LLM gets it as its prompt, a manual judge via `--show`.
const judgmentContext = async (key: PromptKey, profile: string) => {
	const spec = config.prompts[key];
	const publicId = publicIdOf(profile);
	const url = `https://www.linkedin.com/in/${publicId}`;
	const person = await store.read(config.models.People, "LinkedIn URL", url);
	const f = person.fields;

	const prompt = await store.read(config.models.Prompts, "Name", spec.name);
	const [system, instruction] = (["System prompt", "Instruction"] as const).map((k) => {
		if (!prompt.fields[k]) throw new Error(`prompt "${spec.name}" has no ${k}`);
		return String(prompt.fields[k]);
	});
	// The contract's shape. Parse loud — a malformed schema is a broken contract, not a guess.
	const [inputSchema, outputSchema] = (["Input schema", "Output schema"] as const).map((k) => {
		if (!prompt.fields[k]) throw new Error(`prompt "${spec.name}" has no ${k}`);
		try {
			return JSON.parse(String(prompt.fields[k])) as Record<string, unknown>;
		} catch (e) {
			throw new Error(
				`prompt "${spec.name}" ${k} is not valid JSON: ${(e as Error).message}`
			);
		}
	});

	// Project the Person onto the Input schema's fields — the schema names the evidence — and
	// hold the projection to that contract before judging: evidence must respect it. Each
	// field renders as Markdown (structured YAML → bullets) so the evidence reads as one document.
	const keys = Object.keys((inputSchema.properties as Record<string, unknown> | undefined) ?? {});
	const present = keys.filter((k) => f[k]);
	const input = Object.fromEntries(present.map((k) => [k, String(f[k])]));
	if (!ajv.validate(inputSchema, input))
		throw new Error(`evidence violates Input schema: ${ajv.errorsText(ajv.errors)}`);
	const evidence = present.map((k) => `### ${k}\n\n${markdown(String(f[k]))}`).join("\n\n");

	const responseSchema = {
		type: "object",
		required: ["output", "statements"],
		properties: { output: outputSchema, statements: STATEMENTS }
	};
	return {
		spec,
		publicId,
		person,
		prompt,
		system,
		instruction,
		outputSchema,
		evidence,
		responseSchema
	};
};

// decide — the one judgment machine, whatever the contract: judge the person against a
// Prompt row (the LLM, or a manual verdict) and persist one Decision. The judge is pluggable:
// without a verdict, the LLM judges (one retry — temperature 0 varies little, but the error
// nudges it); with one (the manual path, `--verdict`), the caller already judged and a
// violation fails loud immediately — the calling agent is the retry loop. Either way the
// verdict is held to the same contract BEFORE the single write — ajv on the output,
// anchor.validate on the verbatim quotes — so no Decision is ever persisted with input,
// output, or reasoning that disagrees with the contract. Decisions are an append-only log:
// each run is a distinct event, so the page Name carries the run time (like Sourcing) and
// the latest row at a gate is the live one. `Output` holds the structured verdict as JSON,
// `Reasoning` the resolved statements, `Input` the frozen evidence, `Model` the model that
// judged (its AI SDK id, or "manual" for a supplied verdict).
//
// dependsOn makes the Decision a DAG node: it is reviewable only once every upstream
// Decision is Accepted (derived by the review app, never stored). A dependency-free
// decision moves its Lead to the prompt's pending gate; a dependent one leaves Status
// alone — the upstream gate owns it. Human verdict, Final output and Feedback are the
// human's — never written here.
const decide = async (
	key: PromptKey,
	profile: string,
	{ dependsOn, verdict }: { dependsOn?: string[]; verdict?: Verdict } = {}
) => {
	const ctx = await judgmentContext(key, profile);
	const check = (v: Verdict): Statement[] => {
		if (!ajv.validate(ctx.outputSchema, v.output))
			throw new Error(`output violates Output schema: ${ajv.errorsText(ajv.errors)}`);
		resolveQuotes(ctx.evidence, v.output); // output quotes persist resolved, like Reasoning's
		return validate(ctx.evidence, v.statements);
	};

	let output: Record<string, unknown> | undefined;
	let statements: Statement[] | undefined;
	if (verdict) {
		statements = check(verdict);
		output = verdict.output;
	} else {
		const judgePrompt = [ctx.system, ctx.instruction, `## Evidence\n\n${ctx.evidence}`].join(
			"\n\n"
		);
		for (let attempt = 1; !statements; attempt++) {
			const res = await llm.generate<Verdict>(judgePrompt, ctx.responseSchema);
			try {
				statements = check(res);
				output = res.output;
			} catch (e) {
				if (attempt >= 2) throw e;
			}
		}
	}

	const name = String(ctx.person.fields.Name ?? ctx.publicId);
	const ranAt = new Date().toISOString();
	const lead: Leads = {
		Name: name,
		Person: [ctx.person.id],
		...(dependsOn?.length ? {} : { Status: ctx.spec.pending })
	};
	const l = await store.upsert(config.models.Leads, lead, "Name");
	const d = await store.upsert(
		config.models.Decisions,
		{
			Name: `${name} - ${ctx.spec.name} — ${ranAt.slice(0, 19).replace("T", " ")}`,
			Output: JSON.stringify(output),
			Reasoning: JSON.stringify(statements),
			Input: ctx.evidence,
			Model: verdict ? "manual" : llm.MODEL,
			Prompt: [ctx.prompt.id],
			Lead: [l.id],
			...(dependsOn?.length ? { "Depends on": dependsOn } : {})
		} satisfies Decisions,
		"Name"
	);
	return { id: d.id, output, claims: statements.map((s) => s.claim), where: d.url };
};

export const tools = {
	// search — discover LinkedIn profiles via one Google run. Per hit: a Person stub
	// (idempotent on the canonical LinkedIn URL) and, only for a NEW person, a Lead at the
	// pipeline start — re-searching someone already in the pipeline must not reset their
	// Status. Then ONE Sourcing row for the run — an append-only log (each run is a distinct
	// event, so the generated name carries the run time, human-readably) linking the People
	// it yielded, new or not.
	search: async (query: string, n?: number) => {
		const { script, args, hits } = await lkSearchProfiles(query, n);
		const ranAt = new Date().toISOString();
		const out = [];
		const personIds: string[] = [];
		for (const hit of hits) {
			const person: People = {
				Name: hit.name,
				Headline: hit.headline,
				"LinkedIn URL": hit.profileUrl,
				Updated: ranAt
			};
			const p = await store.upsert(config.models.People, person, "LinkedIn URL");
			personIds.push(p.id);
			if (p.created) {
				const lead: Leads = { Name: hit.name, Person: [p.id], Status: "To enrich" };
				await store.upsert(config.models.Leads, lead, "Name");
			}
			out.push({ publicId: hit.publicId, name: hit.name, person: p.url, created: p.created });
		}
		const terms = query.replace(/\bsite:\S+\s*/g, "").trim();
		const sourcing: Sourcing = {
			Name: `Google Search ${terms} — ${ranAt.slice(0, 19).replace("T", " ")}`,
			Script: script,
			Args: JSON.stringify(args),
			"Ran at": ranAt,
			People: personIds
		};
		await store.upsert(config.models.Sourcing, sourcing, "Name");
		return out;
	},

	// enrich — assemble the LinkedIn profile (three runs), fill the Person in (idempotent
	// on the same canonical /in/ URL search writes, NOT card.profileUrl — one key, one page),
	// and move their Lead forward to "To qualify" (created there if the person never went
	// through search: the state converges to reality). Name-keyed Lead, like put-lead.
	enrich: async (profile: string) => {
		const { publicId, card, experience, posts, comments } = await lkGetProfile(profile);
		const name = card.name ?? publicId;
		const person: People = {
			Name: name,
			Headline: card.headline ?? undefined,
			About: card.about ?? undefined,
			Location: card.location ?? undefined,
			"LinkedIn URL": `https://www.linkedin.com/in/${publicId}`,
			Updated: new Date().toISOString(),
			// Store what Reduck gave us, losslessly (YAML — readable, and text stays literal so the
			// judge's verbatim quotes still anchor). No rendering, so no field is ever dropped.
			// lineWidth:0 disables YAML line-folding, so long post text stays on one line and any
			// substring the judge quotes resolves against it.
			Experiences: experience.positions.length
				? stringify(experience.positions, { lineWidth: 0 })
				: undefined,
			Activity:
				posts.posts.length || comments.comments.length
					? stringify(
							{ posts: posts.posts, comments: comments.comments },
							{ lineWidth: 0 }
						)
					: undefined
		};
		const p = await store.upsert(config.models.People, person, "LinkedIn URL");
		const lead: Leads = { Name: name, Person: [p.id], Status: "To qualify" };
		const l = await store.upsert(config.models.Leads, lead, "Name");
		return {
			person: p.url,
			lead: l.url,
			publicId,
			name,
			positions: experience.positions.length,
			posts: posts.posts.length,
			comments: comments.comments.length
		};
	},

	// get-company — pull the LinkedIn company (one run), map to a Company, upsert (idempotent
	// on "LinkedIn URL"). Returns the ref plus companyId — the stable join key downstream.
	getCompany: async (company: string) => {
		const c = await lkGetCompany(company);
		const row: Companies = {
			Name: c.name,
			"LinkedIn URL": c.linkedinUrl ?? undefined,
			Website: c.websiteUrl ?? undefined,
			Description: c.description ?? undefined,
			Tagline: c.tagline ?? undefined,
			Industry: c.industries?.[0],
			Headcount: c.employeeCount ?? undefined,
			Founded: c.foundedYear ?? undefined,
			HQ: hq(c.headquarters)
		};
		const { id, url, created } = await store.upsert(
			config.models.Companies,
			row,
			"LinkedIn URL"
		);
		return { where: url, id, created, companyId: c.companyId, name: c.name };
	},

	// context — the read half of a decision, exposed so a manual judge (a human, or the
	// calling agent) reads the exact context the LLM would: the contract plus the frozen
	// evidence, with the response's expected shape. `--show` prints this; nothing is written.
	context: async (key: PromptKey, profile: string) => {
		const { system, instruction, evidence, responseSchema } = await judgmentContext(
			key,
			profile
		);
		return { system, instruction, evidence, responseSchema };
	},

	// review — a human-reviewed Decision (by its page Name) → the judge's judgment plus the
	// human's diff, the few-shot signal. Pure projection over the row (src/review.ts); the
	// Prompt this example trains is recovered from the Name against the known specs. Reads
	// only — throws (loud) if the Decision hasn't been reviewed.
	review: async (name: string) => {
		const { fields } = await store.read(config.models.Decisions, "Name", name);
		const prompt = Object.values(config.prompts).find((s) => name.includes(s.name))?.name;
		return { name, prompt, ...reviewOf(fields) };
	},

	// qualify — one decide against the qualification contract: does this person fit the ICP?
	// Internal effect only (CRM state); dependency-free, so it opens its own human gate.
	qualify: (profile: string, verdict?: Verdict) => decide("qualify", profile, { verdict }),

	// engage — one decide against the engagement contract: how to open the relationship
	// (the drafted action is the Output). Its effect is outward, so when it follows a
	// qualification in the same run, dependsOn carries that Decision's id and the review
	// app holds this one back until the upstream is Accepted. Without dependsOn it stands
	// alone — engage-directly, no qualification gate.
	engage: (profile: string, opts: { dependsOn?: string[]; verdict?: Verdict } = {}) =>
		decide("engage", profile, opts),

	// put-lead — the join: a Lead is a person, so it needs only that person; its Name is
	// derived from the Person it points at. companyId is optional (the person's company,
	// when known). Idempotent on Name. personId/companyId are the ids the get-* tools return.
	putLead: async ({ personId, companyId }: { personId: string; companyId?: string }) => {
		const lead: Leads = {
			Name: await store.title(config.models.People, personId),
			Person: [personId],
			...(companyId ? { Company: [companyId] } : {}),
			Status: "To enrich"
		};
		const { id, url, created } = await store.upsert(config.models.Leads, lead, "Name");
		return { where: url, id, created };
	}
};
