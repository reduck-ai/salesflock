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
import {
	collectQuotes,
	findQuotes,
	inRange,
	quoteKey,
	type Statement
} from "../../src/anchor.js";
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
// judgment carries. A quote is a [start,end) char range into the Evidence, obtained from the
// `search_quotes` tool: the judge never invents offsets, it cites text and search returns the span.
// This contract lives here, in code, not in the per-agent prompt.
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
				description:
					"the Evidence spans that PROVE this claim — the shortest that do, one per distinct " +
					"proof, each a {start,end} exactly as `search_quotes` returned it. A claim resting on " +
					"the ABSENCE of evidence (e.g. 'no mention of X') has nothing to point at: give an empty " +
					"array — the Evidence's silence is the proof. Never cite unrelated text to fill it.",
				items: {
					type: "object",
					required: ["start", "end"],
					properties: {
						start: {
							type: "integer",
							description: "start offset of the span, from search_quotes"
						},
						end: {
							type: "integer",
							description: "end offset (half-open), from search_quotes"
						}
					}
				}
			}
		}
	}
} as const;

// A judgment, whoever judged: the domain output plus its claim→proof statements. What
// the LLM returns, and what a manual judge hands to `qualify` via --verdict.
export interface Verdict {
	output: Record<string, unknown>;
	statements: Statement[];
}

// showDecision(handle) — one Decision by the shared id, shaped for reading: the judge's
// judgment always (Output, Reasoning statements, and the Evidence RE-RENDERED from the frozen
// Input the way the judge and the app render it), plus the human review diff once ruled. The
// quotes' offsets index this rendered evidence — `Input` stores the lossless MAP, so we must
// render it here (not hand back the raw map) for `evidence.slice(start,end)` to resolve. The
// `show` tool and the few-shot example builder share this exact shaping — an example is literally
// "a decision, shown the way `leads show` shows it".
const showDecision = async (handle: string) => {
	const { id, fields } = await store.get(idOf(handle));
	const name = String(fields.Name ?? id);
	const base = {
		id,
		name,
		kind: kindOf(name),
		output: JSON.parse(String(fields.Output)) as Record<string, unknown>,
		statements: JSON.parse(String(fields.Reasoning)) as Statement[],
		evidence: renderEvidence(JSON.parse(String(fields.Input)) as Record<string, string>),
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
// without a verdict the LLM judges in a two-tool loop — `search_quotes` turns the text it wants
// to cite into {start,end} spans (the judge never invents offsets; code owns them) and
// `submit_claims` commits, the loop stopping the moment a submit is accepted; with one (the
// manual path, `--verdict`) the caller already judged and a violation fails loud immediately —
// the calling agent is the retry loop. Either way the verdict is held to the same contract BEFORE
// the single write — schemaError on the output, and every quote's [start,end) range checked
// in-bounds against the Evidence — so no Decision is ever persisted with input, output, or
// reasoning that disagrees with the contract.
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

	let output: Record<string, unknown> | undefined;
	let statements: Statement[] | undefined;
	let obs: Record<string, number> | undefined;
	if (verdict) {
		// manual path — one-shot; the calling agent is its own retry loop. Both gates are hard:
		// the Output schema, and every quote in-range (its span already resolved by whoever judged).
		const err = schemaError(ctx.outputSchema, verdict.output);
		if (err) throw new Error(`verdict Output violates its schema: ${err}`);
		const bad = collectQuotes(verdict).find((q) => !inRange(ctx.evidence, q));
		if (bad) throw new Error(`verdict quote ${quoteKey(bad)} is out of the Evidence range`);
		({ output, statements } = verdict);
	} else {
		// The two-tool loop. `search_quotes` is the ONLY source of offsets: it canon-matches the text
		// the judge cites and returns every occurrence as a {start,end} span with surrounding context,
		// so repeats are disambiguated by the judge reading that context — not a positional guess. It
		// records each span in `returned`; `submit_claims` then commits only when the Output satisfies
		// its schema and every quote is one of those recorded spans. A rejected submit (its {ok,error}
		// fed back) just continues the loop; the SDK stops the moment one is accepted.
		const returned = new Set<string>();
		let submitted: Verdict | undefined; // set by submit_claims once a judgment passes both gates
		const search_quotes = llm.jsonTool<{ texts: string[] }>({
			description:
				"Locate verbatim quotes in the Evidence. Pass the exact text you intend to cite; get back, " +
				"per text, every occurrence as a {start,end} span with its surrounding `before`/`after` " +
				"context. When a quote occurs more than once, read the context and take the {start,end} of " +
				"the occurrence that fits your point. An empty match list means re-quote an exact substring.",
			schema: {
				type: "object",
				required: ["texts"],
				properties: {
					texts: {
						type: "array",
						items: { type: "string" },
						description: "verbatim substrings of the Evidence you mean to cite"
					}
				}
			},
			execute: ({ texts }) =>
				texts.map((text) => ({
					text,
					matches: findQuotes(ctx.evidence, text).map((q) => {
						returned.add(quoteKey(q));
						return {
							start: q.start,
							end: q.end,
							before: ctx.evidence.slice(Math.max(0, q.start - 48), q.start),
							after: ctx.evidence.slice(q.end, q.end + 48)
						};
					})
				}))
		});
		const submit_claims = llm.jsonTool<Verdict>({
			description:
				"Commit the final judgment: the domain Output plus the claim→proof statements. Every quote " +
				"{start,end} must be one `search_quotes` returned — search for the text first, then submit that span.",
			schema: ctx.responseSchema,
			execute: (v) => {
				const err = schemaError(ctx.outputSchema, v.output);
				if (err) return { ok: false, error: `the Output does not satisfy its schema: ${err}` };
				const bad = collectQuotes(v).find((q) => !inRange(ctx.evidence, q) || !returned.has(quoteKey(q)));
				if (bad)
					return {
						ok: false,
						error: `quote ${quoteKey(bad)} was not returned by search_quotes — search for its text, then submit the span you got back.`
					};
				submitted = v;
				return { ok: true };
			}
		});
		const prompt = [ctx.system, ctx.instruction, ctx.examples, `## Evidence\n\n${ctx.evidence}`]
			.filter(Boolean)
			.join("\n\n");
		const t0 = Date.now();
		// stop on a SUCCESSFUL submit, not merely a submit CALL — hasToolCall("submit_claims") would
		// also halt on a rejected ({ok:false}) submit, killing the retry. Keep this a `submitted` probe.
		const result = await llm.agent(prompt, { search_quotes, submit_claims }, () => submitted !== undefined);
		if (!submitted) throw new Error("judge did not submit a valid decision within the step budget");
		const s = llm.runStats(result, Date.now() - t0);
		obs = { ms: s.ms, steps: s.steps, tokens: s.tokens, searches: s.calls.search_quotes ?? 0, rejected: s.rejects.submit_claims ?? 0 };
		({ output, statements } = submitted);
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
		open: appLink(d.id),
		...(obs ? { obs } : {})
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
