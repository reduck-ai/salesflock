// The tools that earn a TS layer — they do what `reduck run` alone can't: fetch a
// LinkedIn entity and write it to the CRM, or set up a Lead by joining two records that
// are already there. Fetch + compose lives in the Lk client; the record mapping — the
// one model-specific bit — lives here, then goes to the store's upsert directly.

import {
	searchProfiles as lkSearchProfiles,
	getProfile as lkGetProfile,
	getCompany as lkGetCompany,
	publicIdOf,
	type Profile
} from "../../src/clients/lk/index.js";
import { getStore } from "../../src/stores/index.js";
import * as gemini from "../../src/ai/gemini.js";
import { validate, type RawStatement, type Statement } from "../../src/anchor.js";
import { Ajv } from "ajv";
import config from "./config.js";
import type { People } from "./schema/People.js";
import type { Companies } from "./schema/Companies.js";
import type { Leads } from "./schema/Leads.js";
import type { Sourcing } from "./schema/Sourcing.js";
import type { Decisions } from "./schema/Decisions.js";

// The store this agent writes to and the tables it addresses — both chosen in config.ts
// (notion by default). No env: the model→table map and prompt rows all live in one file.
const store = getStore(config.destination);

// A LinkedIn company's headquarters → a one-line HQ string, or undefined if it has none.
const hq = (h: { city?: string | null; geographicArea?: string | null; country?: string | null } | null | undefined) =>
	(h && [h.city, h.geographicArea, h.country].filter(Boolean).join(", ")) || undefined;

// One line per item, tight enough to read as evidence. A repost shows who authored the
// original; a comment shows the post it replied to. Full text — the judge sees everything;
// the store's write guard fails loud if the assembled evidence overruns Notion's read cap.
const norm = (s: string | null | undefined): string => (s ? s.replace(/\s+/g, " ").trim() : "");

// The activity lens as Markdown: what the person posts and where they comment — the ICP's
// "entrepreneurial, active on LinkedIn" signal. undefined when they do neither. Each line
// carries the post's permalink so the judge can ground a comment_post next step (its postUrl):
// an authored post always has one; a commented-on post's url is best-effort (omitted when null).
const activity = (posts: Profile["posts"]["posts"], comments: Profile["comments"]["comments"]): string | undefined => {
	const p = posts.map((x) => {
		const repost = x.repostedBy && x.author && x.author !== x.repostedBy ? `↻ ${x.author}: ` : "";
		const meta = [x.postedAgo, x.reactions && `${x.reactions} reactions`].filter(Boolean).join(" · ");
		return `- ${meta ? meta + " — " : ""}${repost}${norm(x.text) || "(no text)"} (${x.postUrl})`;
	});
	const c = comments.map((x) => {
		const on = x.post.url ? ` (${x.post.url})` : "";
		return `- ${x.postedAgo ?? ""} on ${x.post.author ?? "?"}'s post: ${norm(x.text)} — re: "${norm(x.post.text)}"${on}`;
	});
	const out = [p.length && `#### Posts\n${p.join("\n")}`, c.length && `#### Comments\n${c.join("\n")}`].filter(Boolean);
	return out.length ? out.join("\n\n") : undefined;
};

// The judge's response envelope: the domain `output` — its shape declared by the Prompt's
// Output schema — plus `statements`, the fixed claim→evidence anchoring layer every evidenced
// judgment carries. The verbatim-quote contract lives here, in code, not in the per-agent prompt.
const STATEMENTS = {
	type: "array",
	description: "reasoning as claim→proof: one entry per point that decided the verdict",
	items: {
		type: "object",
		required: ["claim", "quotes"],
		properties: {
			claim: { type: "string", description: "one short sentence tying the evidence to a criterion" },
			quotes: {
				type: "array",
				items: { type: "string" },
				description:
					"the exact text from the Evidence backing the claim, copied verbatim — character-for-character substrings, " +
					"no paraphrase, no ellipses; the shortest that proves the point, one per distinct proof. Empty when the criterion can't be verified."
			}
		}
	}
} as const;

const ajv = new Ajv();

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
			Experiences: experience.positions
				.map((p) => {
					const head = [[p.title, p.company].filter(Boolean).join(" — "), p.dateRange, p.location]
						.filter(Boolean)
						.join(" · ");
					return p.description ? `${head}\n${p.description}` : head;
				})
				.join("\n\n"),
			Activity: activity(posts.posts, comments.comments)
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
		const { id, url, created } = await store.upsert(config.models.Companies, row, "LinkedIn URL");
		return { where: url, id, created, companyId: c.companyId, name: c.name };
	},

	// qualify — the judgment: a pure function of frozen context, never a fetch. The Prompt is
	// the judgment CONTRACT (config.prompts.qualify names the row): System prompt + Instruction
	// (the criteria) + an Input schema (which Person fields are evidence) + an Output schema (the
	// verdict's shape). Changing any of them means a new row, so a Decision's Prompt relation
	// always points at the exact contract the judge saw. The Input is the Person projected onto
	// the Input schema and rendered as Markdown; the judge returns { output ⊨ Output schema,
	// statements }, each statement quoting the evidence verbatim. Both ends are held to their
	// contract BEFORE the single write — ajv on input and output, anchor.validate on the quotes
	// (one retry, then loud) — so no Decision is ever persisted with input, output, or reasoning
	// that disagrees with the contract. The result lands on a Decision page — "<Person> - Lead
	// Qualification", the CURRENT decision at this gate: `Output` holds the structured verdict
	// as JSON, `Reasoning` the resolved statements, `Input` the frozen evidence. The Lead gains
	// the dual backlink and moves to the human gate; Accepted, Ground truth and Feedback are the
	// human's — never written here.
	qualify: async (profile: string) => {
		const publicId = publicIdOf(profile);
		const url = `https://www.linkedin.com/in/${publicId}`;
		const person = await store.read(config.models.People, "LinkedIn URL", url);
		const f = person.fields;

		const prompt = await store.read(config.models.Prompts, "Name", config.prompts.qualify);
		const [system, instruction] = (["System prompt", "Instruction"] as const).map((k) => {
			if (!prompt.fields[k]) throw new Error(`prompt "${config.prompts.qualify}" has no ${k}`);
			return String(prompt.fields[k]);
		});
		// The contract's shape. Parse loud — a malformed schema is a broken contract, not a guess.
		const [inputSchema, outputSchema] = (["Input schema", "Output schema"] as const).map((k) => {
			if (!prompt.fields[k]) throw new Error(`prompt "${config.prompts.qualify}" has no ${k}`);
			try {
				return JSON.parse(String(prompt.fields[k])) as Record<string, unknown>;
			} catch (e) {
				throw new Error(`prompt "${config.prompts.qualify}" ${k} is not valid JSON: ${(e as Error).message}`);
			}
		});

		// Project the Person onto the Input schema's fields — the schema names the evidence — and
		// hold the projection to that contract before spending a judge call: evidence must respect it.
		const keys = Object.keys((inputSchema.properties as Record<string, unknown> | undefined) ?? {});
		const present = keys.filter((k) => f[k]);
		const input = Object.fromEntries(present.map((k) => [k, String(f[k])]));
		if (!ajv.validate(inputSchema, input))
			throw new Error(`evidence violates Input schema: ${ajv.errorsText(ajv.errors)}`);
		const evidence = present.map((k) => `### ${k}\n\n${f[k]}`).join("\n\n");

		// The judge returns { output ⊨ Output schema, statements }. responseSchema steers the
		// model; ajv + anchor.validate then GUARANTEE the persisted artifact — an output that
		// breaks its schema or a quote that doesn't resolve retries once (temperature 0 varies
		// little, but the error nudges it), then fails loud rather than store an inconsistent Decision.
		const judgePrompt = [system, instruction, `## Evidence\n\n${evidence}`].join("\n\n");
		const responseSchema = {
			type: "object",
			required: ["output", "statements"],
			properties: { output: outputSchema, statements: STATEMENTS }
		};
		let output: Record<string, unknown> | undefined;
		let statements: Statement[] | undefined;
		for (let attempt = 1; !statements; attempt++) {
			const res = await gemini.generate<{ output: Record<string, unknown>; statements: RawStatement[] }>(
				judgePrompt,
				responseSchema
			);
			try {
				if (!ajv.validate(outputSchema, res.output))
					throw new Error(`output violates Output schema: ${ajv.errorsText(ajv.errors)}`);
				statements = validate(evidence, res.statements);
				output = res.output;
			} catch (e) {
				if (attempt >= 2) throw e;
			}
		}

		const name = String(f.Name ?? publicId);
		const lead: Leads = { Name: name, Person: [person.id], Status: "Qualification pending approval" };
		const l = await store.upsert(config.models.Leads, lead, "Name");
		const d = await store.upsert(
			config.models.Decisions,
			{
				Name: `${name} - Lead Qualification`,
				Output: JSON.stringify(output),
				Reasoning: JSON.stringify(statements),
				Input: evidence,
				Prompt: [prompt.id],
				Lead: [l.id]
			} satisfies Decisions,
			"Name"
		);
		return { output, claims: statements.map((s) => s.claim), where: d.url };
	},

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
