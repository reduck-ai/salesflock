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
import { idOf } from "../../src/stores/notion.js";
import { reviewOf } from "../../src/review.js";
import * as llm from "../../src/ai/llm.js";
import { annotate, collectQuotes, inRange, mapQuotes, snapQuote, type Statement } from "../../src/anchor.js";
import { schemaError } from "../../src/output.js";
import { stringify } from "yaml";
import config from "./config.js";
import { renderEvidence } from "./evidence.js";
import { projectInput } from "./project.js";
import type { People } from "./schema/People.js";
import type { Companies } from "./schema/Companies.js";
import type { Leads } from "./schema/Leads.js";
import type { Sourcing } from "./schema/Sourcing.js";
import type { Decisions } from "./schema/Decisions.js";

// The store this agent writes to and the tables it addresses — both chosen in config.ts
// (notion by default). No env: the model→table map and prompt specs all live in one file.
const store = getStore(config.destination);

// The review app's base URL (the deployed Decisions surface), if configured. Turns a Decision
// id into a link a human opens to review it — the other half of the shared id: I hand back
// `open`, they click through to the same decision. Fail-soft: omitted when the env is unset.
const appBase = process.env.SALESFLOCK_APP_URL?.replace(/\/+$/, "");
const appLink = (id: string): string | undefined =>
	appBase ? `${appBase}/${id.replace(/-/g, "")}` : undefined;

// A Decision's kind from its page Name — which Prompt spec it was judged against.
const kindOf = (name: string): string | undefined =>
	Object.values(config.prompts).find((s) => name.includes(s.name))?.name;

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
// judgment carries. A quote is a [start,end) char range into the Evidence (plus the text the
// judge means to cite, as its own cross-check); this contract lives here, in code, not in the
// per-agent prompt.
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
				description:
					"the spans of the Evidence backing the claim, as character offsets — the shortest " +
					"that prove the point, one per distinct proof. Every claim needs at least one; a " +
					"point the Evidence can't back is not a statement.",
				items: {
					type: "object",
					required: ["start", "end", "intended_text"],
					properties: {
						start: {
							type: "integer",
							description: "0-based character offset into the Evidence where the quote begins"
						},
						end: {
							type: "integer",
							description: "character offset just past the quote's end (half-open, so end - start = length)"
						},
						intended_text: {
							type: "string",
							description:
								"the exact Evidence text the [start,end) range covers, copied verbatim with the ⟨N⟩ position markers removed — your own check that the offsets are right"
						}
					}
				}
			}
		}
	}
} as const;

// The evidence carries position landmarks (anchor.ts `annotate`) so the judge can place exact
// offsets: an LLM counting chars from 0 drifts worse the deeper the quote, but it can count the
// few chars from the nearest ⟨N⟩. Prompt-only — the offsets it returns index the CLEAN evidence.
const MARKERS =
	"The Evidence below carries position markers like ⟨1200⟩ every ~100 characters: the character " +
	"immediately after ⟨N⟩ is at offset N in the evidence. The markers are NOT part of the evidence — " +
	"ignore them when copying quoted text. Give each quote's start/end as offsets into the evidence " +
	"WITH THE MARKERS REMOVED; find the nearest preceding ⟨N⟩ and count forward to be exact.";

// A judgment, whoever judged: the domain output plus its claim→proof statements. What
// the LLM returns, and what a manual judge hands to `qualify` via --verdict.
export interface Verdict {
	output: Record<string, unknown>;
	statements: Statement[];
}

// showDecision(handle) — one Decision by the shared id, shaped for reading: the judge's
// judgment always (Output, Reasoning statements, frozen Input evidence), plus the human review
// diff once ruled. The `show` tool and the few-shot example builder share this exact shaping —
// an example is literally "a decision, shown the way `leads show` shows it".
const showDecision = async (handle: string) => {
	const { id, fields } = await store.get(idOf(handle));
	const name = String(fields.Name ?? id);
	const base = {
		id,
		name,
		kind: kindOf(name),
		output: JSON.parse(String(fields.Output)) as Record<string, unknown>,
		statements: JSON.parse(String(fields.Reasoning)) as Statement[],
		evidence: String(fields.Input),
		open: appLink(id)
	};
	// present once ruled; JSON.stringify drops the key when undefined, so `show`'s output is unchanged.
	const review = fields["Final output"] ? reviewOf(fields) : undefined;
	return { ...base, review };
};

// examplesFor(key, excludeName) — the few-shot block: the Decisions a human flagged
// `Include as example` in Notion (and committed — Final output set), of this prompt kind, minus
// the person being judged. Each is shown exactly as `leads show` shows it; the committed output
// (the human's, when they overrode the judge) is the gold label. "" when nothing is flagged.
const EXAMPLE_LIMIT = 4;
const examplesFor = async (key: PromptKey, excludeName: string): Promise<string> => {
	const spec = config.prompts[key];
	const rows = await store.query(config.models.Decisions, {
		and: [
			{ property: "Include as example", checkbox: { equals: true } },
			{ property: "Final output", rich_text: { is_not_empty: true } }
		]
	});
	const mine = rows
		.filter((r) => kindOf(String(r.fields.Name)) === spec.name)
		.filter((r) => !String(r.fields.Name).startsWith(excludeName))
		.slice(0, EXAMPLE_LIMIT);
	const shown = await Promise.all(mine.map((r) => showDecision(r.id)));
	const blocks = shown.map((s) => {
		const output = s.review?.human.output ?? s.output;
		const response = JSON.stringify({ output, statements: s.statements }, null, 2);
		return `<example>\n<evidence>\n${s.evidence}\n</evidence>\n<response>\n${response}\n</response>\n</example>`;
	});
	return blocks.length ? `## Examples\n\n<examples>\n${blocks.join("\n")}\n</examples>` : "";
};

// The judgment context: the Prompt row's full contract plus the Person's frozen evidence —
// everything a judge needs, nothing written. Both judges read the exact same context:
// the LLM gets it as its prompt, a manual judge via `--show`.
const judgmentContext = async (key: PromptKey, profile: string) => {
	const spec = config.prompts[key];
	const publicId = publicIdOf(profile);
	const url = `https://www.linkedin.com/in/${publicId}`;
	const person = await store.read(config.models.People, "LinkedIn URL", url);
	const f = person.fields;

	// Prompts are append-only versions sharing a Name; the live contract is the highest Version.
	const versions = await store.query(config.models.Prompts, {
		property: "Name",
		title: { equals: spec.name }
	});
	if (!versions.length) throw new Error(`no prompt "${spec.name}"`);
	const prompt = versions.reduce((a, b) =>
		Number(b.fields.Version ?? 0) > Number(a.fields.Version ?? 0) ? b : a
	);
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

	// Project the Person onto the Input schema (the schema names the evidence) — the lossless map
	// the Decision freezes as `Input` — then render it for the judge. The app renders the same map
	// from the frozen data, so improving `renderEvidence` reflows every Decision with no re-judge.
	const input = projectInput(f, inputSchema);
	const evidence = renderEvidence(input);

	const responseSchema = {
		type: "object",
		required: ["output", "statements"],
		properties: { output: outputSchema, statements: STATEMENTS }
	};
	const examples = await examplesFor(key, String(f.Name ?? ""));
	return {
		spec,
		publicId,
		person,
		prompt,
		system,
		instruction,
		examples,
		outputSchema,
		input,
		evidence,
		responseSchema
	};
};

// decide — the one judgment machine, whatever the contract: judge the person against a
// Prompt row (the LLM, or a manual verdict) and persist one Decision. The judge is pluggable:
// without a verdict, the LLM judges (one retry — temperature 0 varies little, but the error
// nudges it); with one (the manual path, `--verdict`), the caller already judged and a
// violation fails loud immediately — the calling agent is the retry loop. Either way the
// verdict is held to the same contract BEFORE the single write — schemaError on the output,
// and every quote's [start,end) range checked in-bounds against the Evidence — so no Decision
// is ever persisted with input, output, or reasoning that disagrees with the contract.
// Decisions are an append-only log: each run is a distinct event, so the page Name carries the
// run time (like Sourcing) and the latest row at a gate is the live one. The Decision freezes
// `Input` the lossless projected data (JSON map), `Reasoning` the statements whose quotes are
// char ranges into the deterministically-rendered Evidence, `Output` the structured verdict
// (its quotes ranges too), `Model` the model that judged (its AI SDK id, or "manual"). The app
// re-renders the same Evidence from the frozen Input and slices each range, so the highlight is
// exact with no matching.
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
	// Hold the verdict to the contract before the single write — schemaError on the output, and
	// every quote (statements' and any nested in the output) held to one gate: its [start,end)
	// range must lie within the Evidence. A range denotes exactly one span, so there is nothing
	// to resolve and nothing to guess — the offsets are the anchor, frozen as-is.
	const check = (v: Verdict): void => {
		const err = schemaError(ctx.outputSchema, v.output);
		if (err) throw new Error(`output violates Output schema: ${err}`);
		const bad = collectQuotes({ output: v.output, statements: v.statements }).filter(
			(q) => !inRange(ctx.evidence, q)
		);
		if (bad.length)
			throw new Error(
				`quote ranges out of bounds (0..${ctx.evidence.length}):\n- ${bad
					.map((q) => JSON.stringify(q))
					.join("\n- ")}`
			);
	};

	// Offset-correction post-step (removable): the position markers get the judge within tens of
	// chars of its quote; snap each quote onto its own intended_text nearby so the range is exact.
	// Applied to whoever judged, BEFORE the contract check, so we validate and store the corrected
	// form. To remove: drop this and pass the raw verdict/res to check.
	const snap = (v: Verdict): Verdict => mapQuotes(v, (q) => snapQuote(ctx.evidence, q)) as Verdict;

	let output: Record<string, unknown> | undefined;
	let statements: Statement[] | undefined;
	if (verdict) {
		const v = snap(verdict);
		check(v);
		({ output, statements } = v);
	} else {
		const judgePrompt = [ctx.system, ctx.instruction, ctx.examples, MARKERS, `## Evidence\n\n${annotate(ctx.evidence)}`]
			.filter(Boolean)
			.join("\n\n");
		for (let attempt = 1; !statements; attempt++) {
			const v = snap(await llm.generate<Verdict>(judgePrompt, ctx.responseSchema));
			try {
				check(v);
				({ output, statements } = v);
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
			Input: JSON.stringify(ctx.input),
			Model: verdict ? "manual" : llm.MODEL,
			Prompt: [ctx.prompt.id],
			Lead: [l.id],
			...(dependsOn?.length ? { "Depends on": dependsOn } : {})
		} satisfies Decisions,
		"Name"
	);
	return {
		id: d.id,
		output,
		claims: statements.map((s) => s.claim),
		where: d.url,
		open: appLink(d.id)
	};
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
		const { system, instruction, examples, evidence, responseSchema } = await judgmentContext(
			key,
			profile
		);
		return { system, instruction, examples, evidence, responseSchema };
	},

	// list — the decisions awaiting review (the queue), newest edits first as the app orders
	// them. The committed output IS the decision, so an unset "Final output" is the pending
	// marker (no separate verdict column). One row each: the shared id, its Name, kind, and the
	// app link that opens it. Raw pending set (DAG gating is the app's derived, read-time concern).
	list: async () => {
		const rows = await store.query(config.models.Decisions, {
			property: "Final output",
			rich_text: { is_empty: true }
		});
		return rows.map((r) => {
			const name = String(r.fields.Name ?? r.id);
			return { id: r.id, name, kind: kindOf(name), open: appLink(r.id) };
		});
	},

	// show — one Decision by the shared id (an id / Notion URL / app URL, resolved by idOf):
	// the judge's judgment always (Output, Reasoning statements, frozen Input evidence), and —
	// once a human has ruled — the review diff too (reviewOf). Reads only. The id-keyed superset
	// of the old Name-keyed review: what I open when the human pastes me a decision link.
	show: (handle: string) => showDecision(handle),

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
