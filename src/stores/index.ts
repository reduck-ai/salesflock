// The store seam — the one contract every System of Record obeys. A destination is set
// up (describe → a writable JSON-Schema contract, compiled by `sflock`) and written to at
// runtime (upsert/read/title). One interface serves both jobs, so the setup registry and
// the runtime store are the same thing. A destination is chosen per agent in its config.ts.

export interface Ref {
	id: string;
	url: string;
	created: boolean;
}
// A row, as every reader gets it: its id, its scalar columns, and its RELATIONS — apart, because
// they are a different kind of thing. A scalar is content; a relation is a pointer, so it flattens
// to target page ids and never to a string a filter could compare (Notion keys a relation by
// `contains`, not `equals` — see notion.ts `locate`).
//
// `rel` exists so a join can BE a relation rather than a text foreign key copied onto the child.
// Without it a reader could write a link and never read it back, which forces every agent to
// duplicate the join as a column — one more copy, one more writer, one more thing to drift. The
// codec has always exported `relation()` for exactly this ("the one non-scalar a reader needs"); this
// is that reader reaching the Store seam. Empty for a store with no such notion, and `{}` for a row
// whose model declares no relations — never absent, so a caller never guards.
export interface Row {
	id: string;
	fields: Record<string, string | number | boolean>;
	rel: Record<string, string[]>;
}

export interface Store {
	describe(model: string): Promise<Record<string, unknown>>; // JSON Schema of writable props (setup)
	upsert(model: string, record: object, key: string): Promise<Ref>; // idempotent write, keyed by `key`
	// Write a NEW row, no lookup — always an addition, never an update. `upsert` is for a row that
	// CONVERGES (a pipeline entity, keyed so a re-run lands on the same page); `create` is for one that
	// ACCUMULATES — a Decision, whose Name carries the instant it was judged, so an upsert's key lookup
	// is a guaranteed-miss round-trip on every write.
	create(model: string, record: object): Promise<Ref>;
	// Write columns on a row addressed by ID — the write half of `get`, and the third member of the
	// write family: `upsert` finds a row by key, `create` makes one, `patch` edits the one you name.
	// For a row whose identity is not a column (a Decision — created, never keyed), it is the only
	// way to correct a field. Writing "" clears a text property.
	patch(model: string, id: string, record: object): Promise<Ref>;
	read(model: string, key: string, value: unknown): Promise<Row>; // the one row where key = value
	query(model: string, filter: object): Promise<Row[]>; // every row matching a store-native filter
	// ONE page of matches + whether more exist (and the cursor to the next page when it does).
	// The worklist primitive: a consumer that DRAINS (process a page, which moves rows out of the
	// filter, then re-query) may see a partial set; one that reasons on absence must use `query`,
	// which refuses truncation; one that wants the WHOLE set walks the cursor via `queryAll`.
	queryPage(model: string, filter: object, cursor?: string): Promise<{ rows: Row[]; more: boolean; cursor?: string }>;
	get(id: string): Promise<Row>; // the row with this id — model-agnostic (an id implies its model)
	title(model: string, id: string): Promise<string>; // a record's name, by id (the join)
	body(id: string): Promise<string>; // a page's CONTENT as markdown — where authored prose lives
	comment(id: string, text: string): Promise<void>; // append a comment to a page — the obs trail
	archive(id: string): Promise<void>; // move a page to trash (recoverable) — how eager work is deleted
}

import { notion } from "./notion.js";
import { hubspot } from "./hubspot.js";

// name → the backend. A destination that can `describe` itself belongs here; today Notion
// is the full implementation and HubSpot is describe-only (its write path throws, loud).
export const STORES = { notion, hubspot } as const;

export const getStore = (name: keyof typeof STORES): Store => STORES[name];

// queryAll(store, model, filter) — EVERY row matching the filter, however many pages it spans: the
// full-read primitive (a dump, an export), walking queryPage's cursor to the end. The third way to
// read a set, beside `query` (refuses truncation — absence-reasoning) and a drain (partial pages
// are fine — processing empties the filter). Loud if a store reports more pages without a cursor
// to reach them — a silent stop there would be `query`'s truncation bug reintroduced.
export const queryAll = async (store: Store, model: string, filter: object): Promise<Row[]> => {
	const rows: Row[] = [];
	let cursor: string | undefined;
	do {
		const page = await store.queryPage(model, filter, cursor);
		rows.push(...page.rows);
		if (page.more && !page.cursor)
			throw new Error(`queryAll: "${model}" has more rows but the store returned no cursor`);
		cursor = page.more ? page.cursor : undefined;
	} while (cursor);
	return rows;
};

// A prompt row and its pipeline effect. `resolve` is the whole semantics: the committed
// output IS the decision, so a single function of that output yields both where the Lead
// moves (`status`) and whether the outcome advances the pipeline (`advances` — read by the
// DAG gate to unlock speculative dependents; a non-advancing outcome, e.g. "Not qualified",
// deletes them — the review app archives a rejected gate's unreviewed dependents, eager work
// that no longer matters). "Which outcome advances" is a business rule, not derivable from
// the output — so it lives here, declared once, and both consumers (the runtime's `decide`
// pending stamp and the review app's `record`) read the same map of decision kind → semantics.
export interface PromptSpec {
	name: string; // the kind — what a Decision's `Kind` carries, and how the roster resolves its agent
	// The Input field the review app's composer attaches below (unset ⇒ it floats). A declaration
	// ABOUT the prompt rather than part of its contract, so it lives here beside `pending`/`resolve`/
	// `act` rather than in the prompt folder — which holds only what a judgment is made of.
	anchor?: string;
	// Entity Status while the decision awaits the human gate. Absent when the judgment HAS no gate —
	// a calibrated funnel stage that judges without minting a Decision (`judge`, not `decide`): there
	// is nothing to park the entity at, and the stage resolves its Status itself.
	pending?: string;
	// Where the committed output leaves the pipeline entity. ABSENT when this prompt moves no
	// pipeline at all — an offline scorer (the reply judge), which mints no Decision, binds to no
	// entity and is never confirmed. The interface used to assert every prompt advances something;
	// that stopped being true the day a prompt existed only to grade another one's output, and
	// declaring the semantics a prompt HAS beats declaring fiction for the ones it hasn't.
	// Its absence is the ONE test of "is this a reviewable kind" — read by agents/index.ts's KINDS
	// (so the app's filter offers no phantom option) and by the review app's commit, which throws
	// rather than silently persisting a decision it cannot resolve.
	resolve?: (output: Record<string, unknown>) => { status: string; advances: boolean };
	// What committing this decision DOES — the outside-world effect, beside `resolve`'s inside-the-CRM
	// one. Declared here for the same reason `resolve` is: it is a business rule, not derivable from
	// the output, and the human's click is where it belongs — a decision a person approves and a
	// machine then performs in a separate pass has two truths (approved, done) and a window between
	// them that something must model. So the act runs INSIDE the commit: after every gate, before any
	// write, so a failure persists nothing and the row simply stays in the queue.
	//
	// The prompt this one SCORES — set only on a scorer (the reply judge), naming the `config.prompts`
	// key whose drafts it rules on. One string, and three things follow from it with nothing else
	// declared: `sflock eval` grades THIS prompt by comparing its label (a scorer's Output is a
	// boolean, so `===` settles it), grades the prompt it names through this scorer instead, and
	// derives this prompt's own corpus from that one's (`expect` must be ruled valid, `reject`
	// invalid — same evidence, opposite verdict). Before it, core looked up the literal key "judge",
	// which is an agent's naming leaking into the engine.
	grades?: string;
	// It returns the fields its result adds to the pipeline entity (a permalink, a timestamp), merged
	// into the SAME patch that writes `resolve`'s Status — one write, so the deed and its record
	// cannot disagree. Absent ⇒ the decision only moves state, which is every prompt that judges.
	//
	// Guarding is the act's own, and it guards on the DATUM, never on a rung (the rule `hasCommentTree`
	// obeys): it receives the entity's current fields and no-ops when its effect is already recorded,
	// so re-confirming a decision cannot perform it twice.
	act?: (
		output: Record<string, unknown>,
		entity: Record<string, string>
	) => Promise<Record<string, unknown> | null>;
}

// The one thing an agent needs to run (besides secrets): which store, which table each
// logical model maps to, and its prompt specs. Lives in agents/<id>/config.ts; the
// same file `sflock pull` reads. destination defaults to "notion" in config.ts.example, so
// an agent runs out of the box.
export interface AgentConfig {
	destination: keyof typeof STORES;
	models: Record<string, string>; // logical model name → store table/object id
	// The Decision relation that binds a Decision to the pipeline entity this agent advances
	// ("Lead" for the LinkedIn agents, "X Engagement" for x-engage). Declared ONCE here and read by
	// both consumers: the runtime binds the Decision to it (decide.ts), and the review app moves that
	// entity's Status on confirm (app/…/notion.ts). An agent has one pipeline entity, so it's one string.
	//
	// ABSENT when the agent mints no Decision at all — a purely observational agent (geo: ask, search,
	// fetch, record) has no pipeline entity to bind one to, and naming a relation no table has would be
	// fiction. Same rule, and the same reason, as `PromptSpec.resolve`/`pending` being optional: declare
	// the semantics an agent HAS, never a placeholder for the ones it hasn't. Its two readers —
	// `decide.ts`'s `decide` and the review app's commit — are unreachable without a Decision kind.
	entity?: string;
	// The pipeline entity's forward status ladder — the ONE declaration of which way is forward,
	// read by both consumers exactly as `resolve` is: the runtime's stages (which never drag an entity
	// backward) and the review app's commit (an advancing decision may move the entity forward, never
	// regress it). Without it two Decisions tied to one entity fight over its Status and the last
	// confirm wins, undoing a move that already happened. Statuses off the ladder are terminal.
	ladder?: readonly string[];
	// How this agent CLEANS ITS BACKLOG — the other end of the gate `pending` opens, called with the
	// subject's key when a decision is REFUSED. Two callers, one meaning: the review app, the moment a
	// human saves a note without committing (a note is a rejection), and `sflock learn`, when it
	// retires such a row into the corpus. Without it the entity sits at its pending rung with no
	// Decision open on it, a row nobody will ever close. Idempotent, so being called twice is free.
	//
	// A function, not a Status string, for the reason `act` is one: only the agent knows which table
	// holds its backlog and which column keys it, and core must not learn either. It is the mirror of
	// `PromptSpec.act` — that is what approving DOES, this is what refusing does.
	drop?: (subject: string) => Promise<void>;
	prompts?: Record<string, PromptSpec>; // decision kind (e.g. qualify) → its contract row + transitions
	// The LLM, "provider/modelId" (e.g. "bedrock/us.anthropic.claude-sonnet-4-6") — declared here
	// like `destination`, never injected through env (env carries only credentials). Absent,
	// llm.ts's DEFAULT_MODEL applies.
	model?: string;
}
