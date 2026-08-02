// The agent roster — every agent statically registered, resolved by decision KIND (its Prompt's
// Name). All agents write to ONE shared Decisions table, so any reader of mixed decisions (the
// review app, `sflock decisions`) must resolve PER ROW which agent's semantics (`config.prompts`,
// `entity`, `ladder`) and rendering (`evidence.ts`) govern it — the kind names the agent, and
// exactly one agent declares each kind (enforced loud below). Static imports, so every consumer
// (the app's vite bundle, the node CLI) gets the same roster with no dynamic-import machinery.
// Nothing here imports tools/schema, so a fresh agent can register before `sflock pull` ever ran.
//
// REGISTERING AN AGENT — the whole interface, nothing else consults a list:
//   1. agents/<id>/ — the contract files: config.ts, evidence.ts (+ evidence.css only if it emits
//      classes), tools.ts, cli.ts; `sflock pull --agent <id>` generates schema/.
//   2. One line in AGENTS below (a duplicate kind fails loud at load).
//   3. package.json "bin" — the runtime binary.
//   4. app ReviewCard.svelte — import the evidence.css, only if the agent ships one.
//   5. agents/<id>/prompts/<key>/ — one folder per config.prompts key: PROMPT.md (the instructions),
//      input.json, output.json. Shared sections are inlined from the pool (`prompts/<name>.md`) and
//      kept honest by `sflock prompts sync` (src/prompts.ts).
//   6. CRM: the agent's entity table + a dual `config.entity` relation on the shared Decisions. Each
//      Decision carries its `Kind` — spec.name VERBATIM, the join key `agentFor` resolves; a mismatch
//      renders generic and never moves the entity.

import type { AgentConfig, PromptSpec } from "../src/stores/index.js";
import type { Quote } from "../src/anchor.js";
import redditEngage from "./reddit-engage/config.js";
import * as redditEngageEvidence from "./reddit-engage/evidence.js";

export interface Agent {
	id: string; // the agents/<id>/ folder — where this agent's prompt files live
	config: AgentConfig;
	renderEvidence: (input: Record<string, string>) => string;
	fieldSpan: (input: Record<string, string>, key: string) => Quote | null;
}

const agent = (id: string, config: AgentConfig, ev: Omit<Agent, "config" | "id">): Agent => ({
	id,
	config,
	renderEvidence: ev.renderEvidence,
	fieldSpan: ev.fieldSpan
});

// id (the agents/<id>/ folder) → the agent. The CLI resolves --agent here; the app never uses ids.
export const AGENTS: Record<string, Agent> = {
	"reddit-engage": agent("reddit-engage", redditEngage, redditEngageEvidence)
};

// kind (Prompt Name) → the one agent that declares it, plus the spec itself. Two agents declaring
// one kind would make a decision's semantics ambiguous — that's a config bug, failed at load.
const kinds = new Map<string, Agent & { key: string; spec: PromptSpec }>();
for (const a of Object.values(AGENTS))
	for (const [key, spec] of Object.entries(a.config.prompts ?? {})) {
		if (kinds.has(spec.name)) throw new Error(`duplicate decision kind "${spec.name}" across agents`);
		kinds.set(spec.name, { ...a, key, spec });
	}

// The row's own resolver: a Decision's kind → the agent that judged it. undefined for a kind no
// agent declares today (a renamed prompt, a decommissioned agent) — the caller keeps such rows
// readable (generic rendering) but never moves their pipeline.
export const agentFor = (kind?: string): (Agent & { key: string; spec: PromptSpec }) | undefined =>
	kind ? kinds.get(kind) : undefined;

// Every REVIEWABLE kind — the review app's per-Prompt filter options, stable whatever is queued.
// A spec with no `resolve` moves no pipeline, so it mints no Decision and no row can ever carry its
// kind: offering it as a filter would be a phantom option. That is the one test, and it is the
// spec's own declaration rather than a second list to keep in sync — `agentFor` still resolves
// every kind, so such a prompt stays fully authorable through `sflock prompts`.
export const KINDS: string[] = [...kinds.entries()].filter(([, a]) => a.spec.resolve).map(([k]) => k);
