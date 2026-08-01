// The decision engine — agent-agnostic. Decide a person against a Prompt row (an LLM two-tool
// loop, or a manual verdict) and persist ONE Decision, held to the Prompt's Output schema +
// quote-range contract before the write. Extracted from the linkedin-leads agent so every agent
// shares one engine: `createDecider` closes over the agent's store, config, and evidence
// renderers, returning the decision tools (decide/context/list/showDecision).
//
// The LLM decides in a two-tool loop — `search_quotes` turns cited text into {start,end} spans
// (the model never invents offsets; code owns them) and `submit_claims` commits, stopping the
// moment a submit passes both gates (the Output schema, and every quote in-range) BEFORE the write.

import { getStore } from "./stores/index.js";
import type { AgentConfig, PromptSpec, Row, Store } from "./stores/index.js";
import { idOf, pageUrl } from "./stores/notion.js";
import { blocksOf, segmentsOf } from "./stores/notion.codec.js";
import { reviewOf, feedbackOf, renderFeedback } from "./review.js";
import * as llm from "./ai/llm.js";
import { collectQuotes, findQuotes, inRange, quoteKey, type Statement } from "./anchor.js";
import { schemaError } from "./output.js";
import { createHash } from "node:crypto";

// fingerprint(contract) — what the Decision pins alongside its Model: WHICH contract the LLM
// actually ran under. The Prompt relation can't answer that — a page body is mutable in place (and
// transcludes a shared page), and the schema COLUMNS are just as editable under a pinned relation
// (measured: a required Output field added mid-batch retroactively invalidated 9 judged rows, with
// nothing flagging it). So the hash covers the whole contract — body + Input/Output schemas — making
// "a new version is a new row, never an edit" checkable for every part of it: two Decisions citing
// one prompt with different hashes were NOT judged alike. Short — this identifies a version, it does
// not defend against tampering.
const fingerprint = (instructions: string): string =>
	createHash("sha256").update(instructions).digest("hex").slice(0, 12);
const contractOf = (body: string, fields: Record<string, string | number | boolean>): string =>
	[body, fields["Input schema"] ?? "", fields["Output schema"] ?? ""].join("\n");

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
	config: AgentConfig;
	renderEvidence: (input: Record<string, string>) => string;
	store?: Store; // defaults to the config's destination store
}

// A kind's live contract, shaped once by showPrompt: the versioned Prompt row, the authored body,
// both schemas parsed, and the fingerprint a Decision made now would pin.
export interface Contract {
	kind: string;
	id: string;
	url: string;
	version: number;
	hash: string;
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
	body: string;
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

	// livePrompt(name) — the Prompt row that governs a kind TODAY. Prompts are append-only versions
		// sharing a Name, so the live contract is the highest Version. The one resolver: the LLM reads it
	// to build a decision, and the staleness check below reads it to ask whether a past decision's
	// instructions still say what they said.
	const livePrompt = async (name: string): Promise<Row> => {
		const versions = await store.query(config.models.Prompts, { property: "Name", title: { equals: name } });
		if (!versions.length) throw new Error(`no prompt "${name}"`);
		return versions.reduce((a, b) => (Number(b.fields.Version ?? 0) > Number(a.fields.Version ?? 0) ? b : a));
	};

	// showPrompt(kind) — the live contract that governs a kind TODAY, shaped for reading: the
	// versioned row, the authored body, both schemas parsed (loud — a malformed schema is a broken
	// contract), and the fingerprint a Decision made now would pin. The read counterpart of
	// showDecision; `sflock prompts` prints it, and the staleness check compares against its hash.
	//
	// Resolved ONCE per reviewer (the `dsCache` idiom of stores/notion.ts, a promise per key so
	// concurrent callers share one flight). A contract is invariant, so re-reading it per judged item
	// was README #7's "shared context computed once" broken in the most expensive way available — the
	// body is a paged, recursive block walk that dwarfs the per-item reads. And it is a CORRECTNESS
	// fix: an edit landing mid-batch used to split the batch across two contracts (exactly what
	// `fingerprint` above exists to catch); one reviewer is now one contract, so a run is atomic with
	// respect to its instructions. Instance-scoped, never module-global: a CLI process is one run,
	// and a long-lived consumer just makes a fresh reviewer.
	const contracts = new Map<string, Promise<Contract>>();
	const showPrompt = (kind: string): Promise<Contract> => {
		const hit = contracts.get(kind);
		if (hit) return hit;
		// A failure is not cached — it would poison the process; fail loud, then let a retry re-read.
		const flight = resolveContract(kind).catch((e: unknown) => {
			contracts.delete(kind);
			throw e;
		});
		contracts.set(kind, flight);
		return flight;
	};
	const resolveContract = async (kind: string): Promise<Contract> => {
		const prompt = await livePrompt(kind);
		const body = await store.body(prompt.id);
		const [inputSchema, outputSchema] = (["Input schema", "Output schema"] as const).map((k) => {
			if (!prompt.fields[k]) throw new Error(`prompt "${kind}" has no ${k}`);
			try {
				return JSON.parse(String(prompt.fields[k])) as Record<string, unknown>;
			} catch (e) {
				throw new Error(`prompt "${kind}" ${k} is not valid JSON: ${(e as Error).message}`);
			}
		});
		return {
			kind,
			id: prompt.id,
			url: pageUrl(prompt.id),
			version: Number(prompt.fields.Version ?? 0),
			hash: fingerprint(contractOf(body, prompt.fields)),
			inputSchema,
			outputSchema,
			body
		};
	};

	// editPrompt(kind) — the live contract for AUTHORING rather than for judging: the same document
	// `showPrompt` returns, but rendered so its seams are visible (every transcluded region delimited
	// in place and named). The other half of the two-reader rule (src/stores/notion.codec.ts): a judge
	// must not see transclusion markers, and an author must not be blind to them.
	const editPrompt = async (kind: string) => {
		const live = await showPrompt(kind);
		const doc = await store.authoring(live.id);
		return { ...live, ...doc };
	};

	// pushPrompt(kind, markdown) — publish the NEXT version of a kind's contract: a new row, never an
	// edit (README #5 — a Decision pins the fingerprint of the wording it read, so a version is
	// immutable by construction). The prose is the page's body; the machine half (both schema columns)
	// is copied as RAW TEXT from the live row rather than re-serialized, so only the wording moves.
	//
	// The shared regions are the reason this is a tool and not a recipe. A transcluded section is
	// authored on its own page and read by every prompt that syncs it, so publishing must put back a
	// REFERENCE, never the text: paste it as literal prose and this version silently forks — the shared
	// page keeps being edited, and this prompt stops hearing about it. So each region is verified
	// against its original and written back as a reference; a region whose text has been changed is
	// refused, naming the page where it is actually authored.
	const pushPrompt = async (kind: string, markdown: string) => {
		const live = await showPrompt(kind);
		const row = await livePrompt(live.kind); // the RAW schema columns, to copy rather than re-emit
		const blocks: object[] = [];
		for (const seg of segmentsOf(markdown)) {
			if (!seg.shared) {
				blocks.push(...blocksOf(seg.text));
				continue;
			}
			// The original's own rendering — the same blocks the reference serves, so equal text means
			// "unchanged". Compared trimmed: the delimiters sit on their own lines, so the region's text
			// carries the newlines that joined them, not content.
			const original = await store.body(seg.shared);
			if (seg.text.trim() !== original.trim()) {
				const src = (await store.authoring(live.id)).regions.find((r) => r.syncedFrom === seg.shared)?.source;
				throw new Error(
					`this candidate changes a SHARED section — it is authored on ${
						src ? `"${src.title}" (${src.url})` : `block ${seg.shared}`
					}, and every prompt that syncs it reads the same words. Edit it there and re-run ` +
						`\`prompts edit\`, or restore the section here; publishing it as this page's own prose ` +
						`would fork it.`
				);
			}
			blocks.push({
				object: "block",
				type: "synced_block",
				synced_block: { synced_from: { block_id: seg.shared } }
			});
		}
		const version = live.version + 1;
		const ref = await store.create(
			config.models.Prompts,
			{
				Name: live.kind,
				Version: version,
				"Input schema": String(row.fields["Input schema"] ?? ""),
				"Output schema": String(row.fields["Output schema"] ?? "")
			},
			blocks
		);
		return { kind: live.kind, version, from: live.version, id: ref.id, url: ref.url };
	};

	// instructionsHash(kind) — the fingerprint the live contract WOULD get now, so a caller can
	// compare it to what a Decision pinned. Equal ⇒ that judgment's contract still reads the same;
	// different ⇒ someone edited the body (or the shared page it syncs) or a schema column in place
	// instead of adding a version.
	const instructionsHash = async (kind: string): Promise<string> => (await showPrompt(kind)).hash;

	// prompts() — every decision kind this agent declares, each with its live contract's version and
	// fingerprint: the index `sflock prompts list` prints (`show` is one kind in full).
	const prompts = async () =>
		Promise.all(
			Object.entries(config.prompts ?? {}).map(async ([key, spec]) => {
				const { version, hash, url, id } = await showPrompt(spec.name);
				return { key, kind: spec.name, pending: spec.pending, version, hash, id, url };
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
			kind: kindOf(name),
			output: JSON.parse(String(fields.Output)) as Record<string, unknown>,
			statements: JSON.parse(String(fields.Reasoning)) as Statement[],
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
	// `query` returns the fields, and one feedbackOf per row yields both flags): `hasFeedback` (any
	// channel touched) and the stricter `overturned` (the human changed the committed Output — a
	// disagreement, not just a note). "Final output" set = reviewed (the committed output IS the
	// decision); pending is the queue, all is both (a union — every Decision has the property, so
	// is_empty ∪ is_not_empty is exhaustive).
	//
	// `opts.feedback` keeps ONLY the rows carrying a delta, and carries the delta itself — the same
	// `renderFeedback` markdown `showDecision --feedback` prints. It costs nothing: `feedbackOf`
	// already ran per row, and this stops the result being thrown away. That one field is what makes
	// "what have I told this agent?" a single call instead of a list, a manual scan for the flag, and
	// a show per id — which reads the whole corpus of human corrections in one go.
	const list = async (scope: "pending" | "reviewed" | "all" = "pending", opts: { feedback?: boolean } = {}) => {
		const filter = scope === "all" ? { or: [SCOPE.pending, SCOPE.reviewed] } : SCOPE[scope];
		const rows = await store.query(config.models.Decisions, filter);
		return rows.flatMap((r) => {
			const fb = feedbackOf(r.fields);
			if (opts.feedback && !fb) return [];
			const name = String(r.fields.Name ?? r.id);
			return {
				id: r.id,
				name,
				kind: kindOf(name),
				hasFeedback: fb !== null,
				overturned: !!fb?.outputChange,
				...(fb && opts.feedback ? { feedback: renderFeedback(fb) } : {}),
				open: appLink(r.id)
			};
		});
	};

	return {
		store,
		appLink,
		kindOf,
		livePrompt,
		showPrompt,
		editPrompt,
		pushPrompt,
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
	// `accept` means the decision is born committed, so there is no pending gate to park the entity
	// at: the caller resolves its Status itself, and writing `spec.pending` first would be a write
	// nobody ever reads (plus a visible flicker in the CRM).
	linkEntity: (
		subject: Subject,
		spec: PromptSpec,
		opts: { dependsOn?: string[]; accept?: boolean }
	) => Promise<string>;
	// The few-shot block the LLM sees, overridable per agent. Default: prior committed Decisions
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
	//
	// Shared context, so fetched ONCE per kind per decider (same reason and same idiom as the
	// contract above: the corpus doesn't change during a run, and it costs a table query plus a read
	// per example). Only the exclusion is per-item, and it is a filter over what was already
	// fetched — hence one more than the limit is kept, so excluding the subject can't shrink the
	// block below EXAMPLE_LIMIT.
	const EXAMPLE_LIMIT = 4;
	const corpora = new Map<string, Promise<{ name: string; block: string }[]>>();
	const corpusFor = (key: string): Promise<{ name: string; block: string }[]> => {
		const hit = corpora.get(key);
		if (hit) return hit;
		const flight = loadCorpus(key).catch((e: unknown) => {
			corpora.delete(key);
			throw e;
		});
		corpora.set(key, flight);
		return flight;
	};
	const loadCorpus = async (key: string): Promise<{ name: string; block: string }[]> => {
		const spec = config.prompts![key];
		const rows = await store.query(config.models.Decisions, {
			and: [
				{ property: "Include as example", checkbox: { equals: true } },
				{ property: "Final output", rich_text: { is_not_empty: true } }
			]
		});
		const mine = rows
			.filter((r) => kindOf(String(r.fields.Name)) === spec.name)
			.slice(0, EXAMPLE_LIMIT + 1);
		const shown = await Promise.all(mine.map((r) => showDecision(r.id)));
		return shown.map((s) => {
			const output = s.review?.human.output ?? s.output;
			const response = JSON.stringify({ output, statements: s.statements }, null, 2);
			return {
				name: s.name,
				block: `<example>\n<evidence>\n${s.evidence}\n</evidence>\n<response>\n${response}\n</response>\n</example>`
			};
		});
	};
	const examplesFor = async (key: string, excludeName: string): Promise<string> => {
		const blocks = (await corpusFor(key))
			.filter((e) => !e.name.startsWith(excludeName))
			.slice(0, EXAMPLE_LIMIT)
			.map((e) => e.block);
		return blocks.length ? `## Examples\n\n<examples>\n${blocks.join("\n")}\n</examples>` : "";
	};

	// The judgment context: the Prompt row's full contract plus the Person's frozen evidence.
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

		// The live contract, via the ONE shaping (showPrompt): the instructions are the Prompt PAGE's
		// BODY — persona and criteria as one authored markdown document, not a column (prose is
		// written, not compiled) — plus the parsed Input/Output schemas and the fingerprint the
		// Decision below pins.
		const prompt = await reviewer.showPrompt(spec.name);
		const { body: system, inputSchema, outputSchema } = prompt;
		if (!system.trim())
			throw new Error(`prompt "${spec.name}" has an empty body — the instructions live in the page body`);

		// Project the Person onto the Input schema, then render it for the LLM. The app renders the
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
		return { spec, subject, prompt, system, examples, outputSchema, input, evidence, responseSchema };
	};

	// decide — decide the person against a Prompt row (the LLM two-tool loop) and persist one
	// Decision. dependsOn makes the Decision a DAG node: reviewable only once every upstream is
	// Accepted (derived by the app). A dependency-free decision moves its Lead to the prompt's
	// pending gate; a dependent one leaves Status alone.
	//
	// `accept` writes "Final output" ≡ Output in the SAME create — a calibrated stage that commits its
	// own judgment (the review app's Confirm, made by the funnel) is one write, not a create followed
	// by a patch of the row we just made. The caller still owns the consequences (the entity's Status
	// move, the audit comment): what belongs here is only that the Decision is born in the state it
	// means. `name` comes back for the same reason — it is composed here, so nobody needs to re-read
	// the page to learn it.
	const decide = async (
		key: string,
		publicId: string | Subject,
		{ dependsOn, accept }: { dependsOn?: string[]; accept?: boolean } = {}
	) => {
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
			const prompt = [ctx.system, ctx.examples, `## Evidence\n\n${ctx.evidence}`]
				.filter(Boolean)
				.join("\n\n");
			await llm.agent(prompt, { search_quotes, submit_claims }, () => submitted !== undefined, config.model);
			if (!submitted) throw new Error("the model did not submit a valid decision within the step budget");
			({ output, statements } = submitted);
		}

		const ranAt = new Date().toISOString();
		const entityId = await linkEntity(ctx.subject, ctx.spec, { dependsOn, accept });
		const name = `${ctx.subject.name} - ${ctx.spec.name} — ${ranAt.slice(0, 19).replace("T", " ")}`;
		// created, not upserted: the Name carries the instant of the judgment, so a key lookup could
		// never match, and Decisions accumulate rather than converge (append-only).
		const d = await store.create(config.models.Decisions, {
			Name: name,
			Output: JSON.stringify(output),
			...(accept ? { "Final output": JSON.stringify(output) } : {}),
			Reasoning: JSON.stringify(statements),
			Input: JSON.stringify(ctx.input),
			Model: llm.modelName(config.model),
			"Instructions hash": ctx.prompt.hash,
			Prompt: [ctx.prompt.id],
			[config.entity]: [entityId],
			...(dependsOn?.length ? { "Depends on": dependsOn } : {})
		});
		return {
			id: d.id,
			name,
			output,
			claims: statements!.map((s) => s.claim),
			where: d.url,
			open: appLink(d.id)
		};
	};

	// context — the read half of a decision: the contract plus the frozen evidence, with the
	// response's expected shape. `--show` prints this; nothing is written.
	const context = async (key: string, publicId: string) => {
		const { system, examples, evidence, responseSchema } = await judgmentContext(key, publicId);
		return { system, examples, evidence, responseSchema };
	};

	return { ...reviewer, decide, context, judgmentContext };
};
