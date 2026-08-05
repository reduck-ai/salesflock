// The decision engine — agent-agnostic. Judge a subject against a prompt (an LLM two-tool loop) and,
// when a human will rule on the result, persist ONE Decision, held to the prompt's Output schema +
// quote-range contract before the write. Extracted from the linkedin-leads agent so every agent
// shares one engine: `createDecider` closes over the agent's store, config, and evidence renderers,
// returning the decision tools (judge/decide/context/list/showDecision).
//
// The contract comes from FILES (src/prompts.ts): agents/<id>/prompts/<key>/, versioned by git. So a
// Decision freezes what governed it in exactly two columns and needs no relation to resolve either —
// `Kind` (which judgment ruled, and through the roster which agent's semantics and renderer) and
// `Instructions hash` (which wording). Nothing else about a prompt is worth storing on a row: the
// rest is in the repo, at that hash.
//
// The LLM judges in a two-tool loop — `search_quotes` turns cited text into {start,end} spans
// (the model never invents offsets; code owns them) and `submit_claims` commits, stopping the
// moment a submit passes both gates (the Output schema, and every quote in-range) BEFORE the write.
// That loop is `runJudgment` below, and it is deliberately PURE: judging and persisting are two
// jobs (README #7), so a funnel gate nobody reviews takes the verdict without minting a Decision —
// a Decision is the human's queue, and a row born already-committed is noise in it.

import { getStore, queryAll } from "./stores/index.js";
import type { AgentConfig, PromptSpec, Row, Store } from "./stores/index.js";
import { idOf } from "./stores/notion.js";
import { loadPrompt, type Contract } from "./prompts.js";
import { reviewOf, feedbackOf, renderFeedback, SAID } from "./review.js";
import * as llm from "./ai/llm.js";
import { collectQuotes, findQuotes, inRange, quoteKey, type Statement } from "./anchor.js";
import { schemaError } from "./output.js";

// The LLM's response envelope: the domain `output` — its shape declared by the Prompt's Output
// schema — plus `statements`, the fixed claim→evidence anchoring layer every evidenced judgment
// carries. A quote is a [start,end) char range into the Evidence, obtained from `search_quotes`:
// the model never invents offsets, it cites text and search returns the span. This contract lives
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

// responseSchemaFor(outputSchema) — the envelope every evidenced judgment returns: the domain
// output, its shape declared by the Prompt, wrapped in the fixed anchoring layer above. Declared
// once so the loop that enforces it and anything printing the expected shape cannot disagree.
export const responseSchemaFor = (outputSchema: object): Record<string, unknown> => ({
	type: "object",
	required: ["output", "statements"],
	properties: { output: outputSchema, statements: STATEMENTS }
});

// Everything a judgment needs, and nothing else: the instructions, the evidence, and the Output
// contract. A judgment is a pure function of its context (README #7), so this IS the context — no
// store, no entity, no Decision. There is no few-shot block: an example a judgment should learn
// from is worth WRITING INTO the instructions, where it is read, diffed and versioned like every
// other word of them — not assembled per call from whichever CRM rows carried a checkbox.
export interface Judgment {
	system: string;
	evidence: string;
	outputSchema: Record<string, unknown>;
}

// runJudgment(j, model?) — the two-tool loop, and the one place it lives. `search_quotes` is the
// ONLY source of offsets: it canon-matches cited text and returns every occurrence as a {start,end}
// span with context; `submit_claims` commits only when the Output satisfies its schema and every
// quote is one search returned. It WRITES NOTHING, which is what lets it serve all three callers
// without any of them re-implementing it: `decide` (judge, then persist a Decision), a funnel gate
// that only needs the verdict, and the offline eval — which used to carry its own copy of this loop
// and could therefore certify a prompt against code that wasn't the code that runs.
export const runJudgment = async (j: Judgment, model?: string): Promise<Verdict> => {
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
				matches: findQuotes(j.evidence, text).map((q) => {
					returned.add(quoteKey(q));
					return {
						start: q.start,
						end: q.end,
						before: j.evidence.slice(Math.max(0, q.start - 48), q.start),
						after: j.evidence.slice(q.end, q.end + 48)
					};
				})
			}))
	});
	const submit_claims = llm.jsonTool<Verdict>({
		description:
			"Commit the final judgment: the domain Output plus the claim→proof statements. Every quote " +
			"{start,end} must be one `search_quotes` returned — search for the text first, then submit that span.",
		schema: responseSchemaFor(j.outputSchema),
		execute: (v) => {
			const err = schemaError(j.outputSchema, v.output);
			if (err) return { ok: false, error: `the Output does not satisfy its schema: ${err}` };
			const bad = collectQuotes(v).find((q) => !inRange(j.evidence, q) || !returned.has(quoteKey(q)));
			if (bad)
				return {
					ok: false,
					error: `quote ${quoteKey(bad)} was not returned by search_quotes — search for its text, then submit the span you got back.`
				};
			submitted = v;
			return { ok: true };
		}
	});
	const prompt = [j.system, `## Evidence\n\n${j.evidence}`].join("\n\n");
	await llm.agent(prompt, { search_quotes, submit_claims }, () => submitted !== undefined, model);
	if (!submitted) throw new Error("the model did not submit a valid decision within the step budget");
	return submitted;
};

// The subject of a decision — who/what is being judged: the frozen fields projectInput reads, a
// display name for the Decision, and the subject's own store row id (for the entity link below).
export interface Subject {
	key: string; // the handle passed to decide (a LinkedIn publicId, a post URL) — the subject's identity
	name: string; // display name, for the Decision's Name
	fields: Record<string, string | number | boolean>; // source for projectInput
	ref?: string; // the subject's own store row id, when the entity link needs it (e.g. a Lead's Person)
}

// createReviewer(deps) — the READ side of the review surface, needing NO agent entity bridge: list
// decisions by review state (each flagged whether it carries human feedback) and show one decision
// (the LLM's decision, the human diff once ruled, and the feedback snapshot). createDecider builds
// on this and adds the bridge-coupled judging; the agent-agnostic `sflock decisions` CLI uses it directly.
export interface ReviewerDeps {
	id: string; // the agents/<id>/ folder — where this agent's prompt files live
	config: AgentConfig;
	renderEvidence: (input: Record<string, string>) => string;
	store?: Store; // defaults to the config's destination store
}

export type { Contract };

// The review states, compiled from the ONE declaration of which columns carry a verdict
// (src/review.ts `SAID`) — the same fact the app's queue reads, so the operator's "pending" and the
// reviewer's "To review" cannot come to name different sets. PENDING is nothing said; REVIEWED is
// anything said, which spans both ways of saying it (a committed output, or a note that refused).
// Their union is still exhaustive — every row is in exactly one — so `--all` stays a plain `or`.
const said = (is_not_empty: boolean) => SAID.map((property) => ({ property, rich_text: { [is_not_empty ? "is_not_empty" : "is_empty"]: true } }));
const SCOPE = {
	pending: { and: said(false) },
	reviewed: { or: said(true) }
} as const;

export const createReviewer = ({ id: agentId, config, renderEvidence, store: given }: ReviewerDeps) => {
	const store = given ?? getStore(config.destination);

	// The review app's base URL (the deployed Decisions surface), if configured. Turns a Decision
	// id into a link a human opens to review it — the other half of the shared id. Fail-soft.
	const appBase = process.env.SALESFLOCK_APP_URL?.replace(/\/+$/, "");
	const appLink = (id: string): string | undefined =>
		appBase ? `${appBase}/${id.replace(/-/g, "")}` : undefined;

	// A Decision's kind — which prompt spec judged it — read off its own `Kind` column. It used to be
	// parsed out of the page Name (`name.includes(spec.name)`), which is ambiguous by construction:
	// "Reddit Reply" is a substring of "Reddit Reply Judge". One written string, no parser.
	const kindOf = (fields: Record<string, string | number | boolean>): string | undefined =>
		fields.Kind ? String(fields.Kind) : undefined;

	// kind (the Prompt Name a Decision carries) → the config key, which IS the prompt's folder name.
	// The one place the two namings meet: rows speak kinds, files speak keys.
	const keyOf = (kind: string): string => {
		const hit = Object.entries(config.prompts ?? {}).find(([k, s]) => s.name === kind || k === kind);
		if (!hit) throw new Error(`no prompt "${kind}" — declare it in this agent's config.ts`);
		return hit[0];
	};

	// prompt(kind|key) — the contract that governs a kind TODAY: the folder under
	// agents/<id>/prompts/. Instructions, both schemas, and the fingerprint a Decision made now would
	// pin, all from files (src/prompts.ts) — no Notion row, no version column, no publish step.
	const prompt = (kind: string): Promise<Contract> => loadPrompt(agentId, keyOf(kind));

	// instructionsHash(kind) — the fingerprint the contract WOULD get now, so a caller can compare it
	// to what a Decision pinned. Equal ⇒ that judgment's wording still stands; different ⇒ the files
	// have moved since, and `git log -S` says who moved them.
	const instructionsHash = async (kind: string): Promise<string> => (await prompt(kind)).hash;

	// prompts() — every decision kind this agent declares, each with the fingerprint of the contract
	// governing it today, and the folder it is authored in.
	const prompts = async () =>
		Promise.all(
			Object.entries(config.prompts ?? {}).map(async ([key, spec]) => {
				const { hash, dir } = await loadPrompt(agentId, key);
				return { key, kind: spec.name, pending: spec.pending, hash, dir };
			})
		);

	// showDecision(handle) — one Decision by the shared id, shaped for reading: the LLM's decision
	// always (Output, Reasoning statements, and the Evidence RE-RENDERED from the frozen Input the way
	// the model and the app render it), the feedback snapshot (the human delta, in any state), and the
	// full review diff once ruled. The `show` tool and the few-shot example builder share this shaping.
	const showDecision = async (handle: string) => {
		const { id, fields } = await store.get(idOf(handle));
		const name = String(fields.Name ?? id);
		const base = {
			id,
			name,
			kind: kindOf(fields),
			subject: fields.Subject ? String(fields.Subject) : undefined,
			output: JSON.parse(String(fields.Output)) as Record<string, unknown>,
			statements: JSON.parse(String(fields.Reasoning)) as Statement[],
			// Both projections of the frozen evidence, because two readers need different ones: a human
			// reads it RENDERED, and a consumer that re-projects it onto another prompt's Input schema
			// (`sflock learn`, retargeting a note to the judgment it is really about) needs the MAP.
			// Re-parsing the column downstream would be a second place for that decoding to live.
			input: JSON.parse(String(fields.Input)) as Record<string, string>,
			evidence: renderEvidence(JSON.parse(String(fields.Input)) as Record<string, string>),
			model: fields.Model ? String(fields.Model) : undefined,
			// the instructions this judgment was made under — compare with instructionsHash(kind)
			instructions: fields["Instructions hash"] ? String(fields["Instructions hash"]) : undefined,
			open: appLink(id)
		};
		const review = fields["Final output"] ? reviewOf(fields) : undefined;
		return { ...base, feedback: feedbackOf(fields), review };
	};

	// list(scope, opts) — decisions by review state, each flagged with the human delta it carries (free —
	// the rows arrive with their fields, and one feedbackOf per row yields every flag): `hasFeedback`
	// (any channel touched), the stricter `overturned` (the human changed the committed Output — a
	// disagreement, not just a note), and `rejected` (a note with nothing committed — they refused it).
	// "Final output" set = reviewed (the committed output IS the
	// decision); pending is the queue, all is both (a union — every Decision has the property, so
	// is_empty ∪ is_not_empty is exhaustive).
	//
	// EVERY page, via `queryAll`, not `query`. Decisions accumulate forever, so all three scopes
	// outgrow one page — and `query` REFUSES a truncated read rather than return a partial set, which
	// is right for a caller reasoning on absence and wrong for this one: listing is enumeration, and
	// once the table passed 100 rows `--all` stopped working entirely instead of paging (measured).
	// The invariant is intact either way — the failure mode `query` protects against is a silent
	// partial set, and walking the cursor to the end is the other way to not have one.
	//
	// `opts.feedback` keeps the rows carrying a NOTE, and carries the delta itself — the same
	// `renderFeedback` markdown `showDecision --feedback` prints. It costs nothing: `feedbackOf`
	// already ran per row. That one field is what makes "what have I told this agent?" a single call
	// instead of a list, a manual scan for the flag, and a show per id.
	//
	// The NOTE, not any delta, and that is what makes this a worklist rather than an archive. A note
	// is a TODO — "this regressed, do something" — and `sflock learn` is the something: it moves the
	// note into a ground-truth case and clears it here, so this list DRAINS. An overturn cannot be
	// cleared and must not be: rewriting `Output` or `Final output` would falsify what was judged and
	// what was posted. So it stays, visible as `overturned` on the plain list, where it belongs —
	// history, not an ask. Filtering on `feedbackOf() !== null` fused the two, and every overturned
	// row would sit in this queue forever however many times it had been learned from.
	const list = async (scope: "pending" | "reviewed" | "all" = "pending", opts: { feedback?: boolean } = {}) => {
		const filter = scope === "all" ? { or: [SCOPE.pending, SCOPE.reviewed] } : SCOPE[scope];
		const rows = await queryAll(store, config.models.Decisions, filter);
		return rows.flatMap((r) => {
			const fb = feedbackOf(r.fields);
			if (opts.feedback && !fb?.note) return [];
			const name = String(r.fields.Name ?? r.id);
			return {
				id: r.id,
				name,
				kind: kindOf(r.fields),
				subject: r.fields.Subject ? String(r.fields.Subject) : undefined,
				hasFeedback: fb !== null,
				overturned: !!fb?.outputChange,
				// A NOTE WITH NOTHING COMMITTED IS A REJECTION — the review app's third verdict, read
				// here off the same two columns it writes (app: server/notion.ts `SAID`). It is what
				// splits this worklist into its two kinds of work: a refused draft needs a case, an
				// archive and its entity closed, while an approved-with-a-note needs only the note
				// moved out. `learn` already does the right thing with each; this is what lets you SEE
				// which is which without opening every row.
				rejected: !r.fields["Final output"] && !!fb?.note,
				...(fb && opts.feedback ? { feedback: renderFeedback(fb) } : {}),
				open: appLink(r.id)
			};
		});
	};

	return {
		store,
		appLink,
		kindOf,
		keyOf,
		prompt,
		prompts,
		instructionsHash,
		showDecision,
		list
	};
};

export interface DeciderDeps extends ReviewerDeps {
	projectInput: (
		fields: Record<string, string | number | boolean>,
		inputSchema: Record<string, unknown>
	) => Record<string, string>;
	// The agent-specific bridge (what decide.ts used to hardcode to LinkedIn): fetch the subject's
	// evidence, and bind/advance its pipeline row. The two seams alongside renderEvidence/projectInput.
	resolveSubject: (key: string) => Promise<Subject>;
	// Advance the subject's pipeline entity row (to the prompt's `pending` Status, unless it's a held
	// DAG dependent — the one place the domain funnel advances) and return that row's id. The relation
	// it binds to is `config.entity`, so linkEntity no longer reports it — it just hands back the id.
	linkEntity: (subject: Subject, spec: PromptSpec, opts: { dependsOn?: string[] }) => Promise<string>;
}

// createDecider(deps) — the decision tools bound to one agent's store + config + LinkedIn renderers:
// the read side (createReviewer) plus the bridge-coupled judging (decide/context/judgmentContext).
export const createDecider = (deps: DeciderDeps) => {
	const { config, renderEvidence, projectInput, resolveSubject, linkEntity } = deps;
	const reviewer = createReviewer(deps);
	const { store, appLink } = reviewer;

	// The judgment context: the prompt folder's full contract plus the subject's frozen evidence.
	//
	// `handle` may be the subject's key OR an already-resolved Subject. A judgment is a pure function
	// of its context (README #7), so handing the context in is more honest than re-fetching it: a
	// caller that already read the row — to check a funnel guard, say — shouldn't pay for a second
	// read of the same row. Pass the key when you want it fresh (a later stage reading what an
	// earlier one just wrote), pass the Subject when you already hold it.
	const judgmentContext = async (key: string, handle: string | Subject) => {
		const spec = config.prompts![key];
		const subject = typeof handle === "string" ? await resolveSubject(handle) : handle;
		const f = subject.fields;

		// The contract, from the agent's own prompt folder (src/prompts.ts): the instructions as one
		// authored markdown document, both schemas, and the fingerprint the Decision below pins.
		const prompt = await reviewer.prompt(key);
		const { body: system, inputSchema, outputSchema } = prompt;

		// Project the Person onto the Input schema, then render it for the LLM. The app renders the
		// same map from the frozen data, so improving `renderEvidence` reflows every Decision.
		const input = projectInput(f, inputSchema);
		const evidence = renderEvidence(input);

		const responseSchema = responseSchemaFor(outputSchema);
		return { spec, subject, prompt, system, outputSchema, input, evidence, responseSchema };
	};

	// judge — the verdict alone: the contract, the frozen evidence, the two-tool loop, and nothing
	// persisted. For a stage whose judgment nobody will rule on, so no Decision should exist: a
	// Decision is the human's queue, and a row born already-committed is noise in it. The caller
	// keeps whatever the verdict is worth (a column on its entity, a comment on its page) and owns
	// the entity's Status itself — there is no gate to park it at.
	const judge = async (key: string, handle: string | Subject): Promise<Verdict> =>
		runJudgment(await judgmentContext(key, handle), config.model);

	// decide — judge, then persist ONE Decision: the same loop as `judge`, plus everything that makes
	// it reviewable. dependsOn makes the Decision a DAG node: reviewable only once every upstream is
	// Accepted (derived by the app). A dependency-free decision moves its entity to the prompt's
	// pending gate; a dependent one leaves Status alone. `name` comes back because it is composed
	// here, so nobody needs to re-read the page to learn it.
	const decide = async (
		key: string,
		publicId: string | Subject,
		{ dependsOn }: { dependsOn?: string[] } = {}
	) => {
		const ctx = await judgmentContext(key, publicId);
		const { output, statements } = await runJudgment(ctx, config.model);

		const ranAt = new Date().toISOString();
		const entityId = await linkEntity(ctx.subject, ctx.spec, { dependsOn });
		const name = `${ctx.subject.name} - ${ctx.spec.name} — ${ranAt.slice(0, 19).replace("T", " ")}`;
		// created, not upserted: the Name carries the instant of the judgment, so a key lookup could
		// never match, and Decisions accumulate rather than converge (append-only).
		const d = await store.create(config.models.Decisions, {
			Name: name,
			Output: JSON.stringify(output),
			Reasoning: JSON.stringify(statements),
			Input: JSON.stringify(ctx.input),
			Model: llm.modelName(config.model),
			// WHICH judgment, and under WHICH wording — the two halves of "what ruled on this row", and
			// both are now plain columns. `Kind` replaced a relation into a Prompts table that no longer
			// exists: with the contract in git, the row's only remaining job was to hold this one string.
			Kind: ctx.spec.name,
			// WHAT this decision is about, as the subject's own identity key (a thread URL) — the one
			// datum a Decision could not previously state about itself. Its Name carries a truncated
			// label and its entity rides in a relation the store flattens away, so "which thread is
			// this?" cost a read of the frozen Input and a parse of an agent's seed. It is also what
			// `sflock learn` keys a ground-truth case on, so a learning lands in the same key space
			// the corpus already uses however many decisions were made about one subject.
			Subject: ctx.subject.key,
			"Instructions hash": ctx.prompt.hash,
			[config.entity]: [entityId],
			...(dependsOn?.length ? { "Depends on": dependsOn } : {})
		});
		return {
			id: d.id,
			name,
			// The pipeline entity this decision opened — already in hand from linkEntity, so handing it
			// back costs nothing and saves the caller a read of a row it just caused to exist. An agent
			// whose funnel relates OTHER rows to that entity (reddit-engage attaches a person's remaining
			// threads to the outreach it just opened) needs the id, and re-querying for it would be
			// asking the store to tell us something we computed one line ago.
			entity: entityId,
			output,
			claims: statements.map((s) => s.claim),
			where: d.url,
			open: appLink(d.id)
		};
	};

	// context — the read half of a decision: the contract plus the frozen evidence, with the
	// response's expected shape. `--show` prints this; nothing is written.
	const context = async (key: string, publicId: string) => {
		const { system, evidence, responseSchema } = await judgmentContext(key, publicId);
		return { system, evidence, responseSchema };
	};

	return { ...reviewer, judge, decide, context, judgmentContext };
};
