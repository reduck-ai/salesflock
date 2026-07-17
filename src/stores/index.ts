// The store seam — the one contract every System of Record obeys. A destination is set
// up (describe → a writable JSON-Schema contract, compiled by `sflock`) and written to at
// runtime (upsert/read/title). One interface serves both jobs, so the setup registry and
// the runtime store are the same thing. A destination is chosen per agent in its config.ts.

export interface Ref {
	id: string;
	url: string;
	created: boolean;
}
export interface Row {
	id: string;
	fields: Record<string, string | number | boolean>;
}

export interface Store {
	describe(model: string): Promise<Record<string, unknown>>; // JSON Schema of writable props (setup)
	upsert(model: string, record: object, key: string): Promise<Ref>; // idempotent write, keyed by `key`
	read(model: string, key: string, value: unknown): Promise<Row>; // the one row where key = value
	title(model: string, id: string): Promise<string>; // a record's name, by id (the join)
}

import { notion } from "./notion.js";
import { hubspot } from "./hubspot.js";

// name → the backend. A destination that can `describe` itself belongs here; today Notion
// is the full implementation and HubSpot is describe-only (its write path throws, loud).
export const STORES = { notion, hubspot } as const;

export const getStore = (name: keyof typeof STORES): Store => STORES[name];

// A prompt row and its pipeline effect: the Lead Status while its decision awaits the
// human gate, and where each verdict moves it. The one map of decision kind → pipeline
// semantics, read by both sides of the gate: the runtime (decide) and the review app (record).
export interface PromptSpec {
	name: string; // the Prompt row's Name
	pending: string; // Lead Status while the decision awaits the human gate
	onAccept: string; // Lead Status when the human accepts
	onReject: string; // Lead Status when the human rejects
}

// The one thing an agent needs to run (besides secrets): which store, which table each
// logical model maps to, and its prompt specs. Lives in agents/<id>/config.ts; the
// same file `sflock pull` reads. destination defaults to "notion" in config.ts.example, so
// an agent runs out of the box.
export interface AgentConfig {
	destination: keyof typeof STORES;
	models: Record<string, string>; // logical model name → store table/object id
	prompts?: Record<string, PromptSpec>; // decision kind (e.g. qualify) → its contract row + transitions
}
