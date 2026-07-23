// The judgment engine — agent-agnostic. Judge a person against a Prompt row (an LLM two-tool loop,
// or a manual verdict) and persist ONE Decision, held to the Prompt's Output schema + quote-range
// contract before the write. Extracted from the linkedin-leads agent so every LinkedIn agent
// (linkedin-leads, former-rpa-pms) shares one judge: `createDecider` closes over the agent's store,
// config, and evidence renderers, returning the decision tools (decide/context/list/showDecision).
//
// The LLM judges in a two-tool loop — `search_quotes` turns cited text into {start,end} spans (the
// judge never invents offsets; code owns them) and `submit_claims` commits, stopping the moment a
// submit passes both gates (the Output schema, and every quote in-range) BEFORE the single write.

import { getStore } from "./stores/index.js";
import type { AgentConfig, PromptSpec, Store } from "./stores/index.js";
import { idOf } from "./stores/notion.js";
import { reviewOf, feedbackOf } from "./review.js";
import * as llm from "./ai/llm.js";
import { collectQuotes, findQuotes, inRange, quoteKey, type Statement } from "./anchor.js";
import { schemaError } from "./output.js";

// The judge's response envelope: the domain `output` — its shape declared by the Prompt's Output
// schema — plus `statements`, the fixed claim→evidence anchoring layer every evidenced judgment
// carries. A quote is a [start,end) char range into the Evidence, obtained from `search_quotes`:
// the judge never invents offsets, it cites text and search returns the span. This contract lives
// here, in code, not in the per-agent prompt.
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

// A judgment: the domain output plus its claim→proof statements — what the LLM submits via submit_claims.
export interface Verdict {
	output: Record<string, unknown>;
	statements: Statement[];
}

// The subject of a decision — who/what is being judged: the frozen fields projectInput reads, a
// display name for the Decision, and the subject's own store row id (for the entity link below).
export interface Subject {
	key: string; // the handle passed to decide (a LinkedIn publicId, a post URL) — the subject's identity
	name: string; // display name, for the Decision's Name
	fields: Record<string, string | number | boolean>; // source for projectInput
	ref?: string; // the subject's own store row id, when the entity link needs it (e.g. a Lead's Person)
}

// The Decision's binding to its pipeline entity (a Lead, an X Engagement): which Decision property
// relates to it, and the row id. linkEntity also moves that row to the prompt's `pending` Status
// (unless the decision is a held DAG dependent) — the one place the domain funnel advances.
export interface EntityLink {
	relation: string;
	id: string;
}

// createReviewer(deps) — the READ side of the review surface, needing NO agent entity bridge: list
// decisions by review state (each flagged whether it carries human feedback) and show one decision
// (the judge's judgment, the human diff once ruled, and the feedback snapshot). createDecider builds
// on this and adds the bridge-coupled judging; the agent-agnostic `sflock decisions` CLI uses it directly.
export interface ReviewerDeps {
	config: AgentConfig;
	renderEvidence: (input: Record<string, string>) => string;
	store?: Store; // defaults to the config's destination store
}

const SCOPE = {
	pending: { property: "Final output", rich_text: { is_empty: true } },
	reviewed: { property: "Final output", rich_text: { is_not_empty: true } }
} as const;

export const createReviewer = ({ config, renderEvidence, store: given }: ReviewerDeps) => {
	const store = given ?? getStore(config.destination);

	// The review app's base URL (the deployed Decisions surface), if configured. Turns a Decision
	// id into a link a human opens to review it — the other half of the shared id. Fail-soft.
	const appBase = process.env.SALESFLOCK_APP_URL?.replace(/\/+$/, "");
	const appLink = (id: string): string | undefined =>
		appBase ? `${appBase}/${id.replace(/-/g, "")}` : undefined;

	// A Decision's kind from its page Name — which Prompt spec it was judged against.
	const kindOf = (name: string): string | undefined =>
		Object.values(config.prompts ?? {}).find((s) => name.includes(s.name))?.name;

	// showDecision(handle) — one Decision by the shared id, shaped for reading: the judge's judgment
	// always (Output, Reasoning statements, and the Evidence RE-RENDERED from the frozen Input the way
	// the judge and the app render it), the feedback snapshot (the human delta, in any state), and the
	// full review diff once ruled. The `show` tool and the few-shot example builder share this shaping.
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
		const review = fields["Final output"] ? reviewOf(fields) : undefined;
		return { ...base, feedback: feedbackOf(fields), review };
	};

	// list(scope) — decisions by review state, each flagged with the human delta it carries (free —
	// `query` returns the fields, and one feedbackOf per row yields both flags): `hasFeedback` (any
	// channel touched) and the stricter `overturned` (the human changed the committed Output — a
	// disagreement, not just a note). "Final output" set = reviewed (the committed output IS the
	// decision); pending is the queue, all is both (a union — every Decision has the property, so
	// is_empty ∪ is_not_empty is exhaustive).
	const list = async (scope: "pending" | "reviewed" | "all" = "pending") => {
		const filter = scope === "all" ? { or: [SCOPE.pending, SCOPE.reviewed] } : SCOPE[scope];
		const rows = await store.query(config.models.Decisions, filter);
		return rows.map((r) => {
			const fb = feedbackOf(r.fields);
			const name = String(r.fields.Name ?? r.id);
			return { id: r.id, name, kind: kindOf(name), hasFeedback: fb !== null, overturned: !!fb?.outputChange, open: appLink(r.id) };
		});
	};

	return { store, appLink, kindOf, showDecision, list };
};

export interface DeciderDeps extends ReviewerDeps {
	projectInput: (
		fields: Record<string, string | number | boolean>,
		inputSchema: Record<string, unknown>
	) => Record<string, string>;
	// The agent-specific bridge (what decide.ts used to hardcode to LinkedIn): fetch the subject's
	// evidence, and bind/advance its pipeline row. The two seams alongside renderEvidence/projectInput.
	resolveSubject: (key: string) => Promise<Subject>;
	linkEntity: (subject: Subject, spec: PromptSpec, opts: { dependsOn?: string[] }) => Promise<EntityLink>;
	// The few-shot block the judge sees, overridable per agent. Default: prior committed Decisions
	// (examplesFor). x-engage supplies the owner's own Posts+Replies — its authentic voice — instead.
	renderExamples?: (key: string, subject: Subject) => Promise<string>;
}

// createDecider(deps) — the decision tools bound to one agent's store + config + LinkedIn renderers:
// the read side (createReviewer) plus the bridge-coupled judging (decide/context/judgmentContext).
export const createDecider = (deps: DeciderDeps) => {
	const { config, renderEvidence, projectInput, resolveSubject, linkEntity } = deps;
	const reviewer = createReviewer(deps);
	const { store, appLink, kindOf, showDecision } = reviewer;

	// examplesFor(key, excludeName) — the few-shot block: the Decisions a human flagged
	// `Include as example` (and committed), of this prompt kind, minus the person being judged.
	const EXAMPLE_LIMIT = 4;
	const examplesFor = async (key: string, excludeName: string): Promise<string> => {
		const spec = config.prompts![key];
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

	// The judgment context: the Prompt row's full contract plus the Person's frozen evidence.
	const judgmentContext = async (key: string, handle: string) => {
		const spec = config.prompts![key];
		const subject = await resolveSubject(handle);
		const f = subject.fields;

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
				throw new Error(`prompt "${spec.name}" ${k} is not valid JSON: ${(e as Error).message}`);
			}
		});

		// Project the Person onto the Input schema, then render it for the judge. The app renders the
		// same map from the frozen data, so improving `renderEvidence` reflows every Decision.
		const input = projectInput(f, inputSchema);
		const evidence = renderEvidence(input);

		const responseSchema = {
			type: "object",
			required: ["output", "statements"],
			properties: { output: outputSchema, statements: STATEMENTS }
		};
		const examples = deps.renderExamples
			? await deps.renderExamples(key, subject)
			: await examplesFor(key, String(f.Name ?? subject.name));
		return { spec, subject, prompt, system, instruction, examples, outputSchema, input, evidence, responseSchema };
	};

	// decide — judge the person against a Prompt row (the LLM two-tool loop) and persist one
	// Decision. dependsOn makes the Decision a DAG node: reviewable only once every upstream is
	// Accepted (derived by the app). A dependency-free decision moves its Lead to the prompt's
	// pending gate; a dependent one leaves Status alone.
	const decide = async (key: string, publicId: string, { dependsOn }: { dependsOn?: string[] } = {}) => {
		const ctx = await judgmentContext(key, publicId);

		let output: Record<string, unknown> | undefined;
		let statements: Statement[] | undefined;
		{
			// The two-tool loop. `search_quotes` is the ONLY source of offsets: it canon-matches cited
			// text and returns every occurrence as a {start,end} span with context; `submit_claims`
			// commits only when the Output satisfies its schema and every quote is one search returned.
			const returned = new Set<string>();
			let submitted: Verdict | undefined;
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
			await llm.agent(prompt, { search_quotes, submit_claims }, () => submitted !== undefined);
			if (!submitted) throw new Error("judge did not submit a valid decision within the step budget");
			({ output, statements } = submitted);
		}

		const ranAt = new Date().toISOString();
		const link = await linkEntity(ctx.subject, ctx.spec, { dependsOn });
		const d = await store.upsert(
			config.models.Decisions,
			{
				Name: `${ctx.subject.name} - ${ctx.spec.name} — ${ranAt.slice(0, 19).replace("T", " ")}`,
				Output: JSON.stringify(output),
				Reasoning: JSON.stringify(statements),
				Input: JSON.stringify(ctx.input),
				Model: llm.MODEL,
				Prompt: [ctx.prompt.id],
				[link.relation]: [link.id],
				...(dependsOn?.length ? { "Depends on": dependsOn } : {})
			},
			"Name"
		);
		return {
			id: d.id,
			output,
			claims: statements!.map((s) => s.claim),
			where: d.url,
			open: appLink(d.id)
		};
	};

	// context — the read half of a decision: the contract plus the frozen evidence, with the
	// response's expected shape. `--show` prints this; nothing is written.
	const context = async (key: string, publicId: string) => {
		const { system, instruction, examples, evidence, responseSchema } = await judgmentContext(key, publicId);
		return { system, instruction, examples, evidence, responseSchema };
	};

	return { ...reviewer, decide, context, judgmentContext };
};
