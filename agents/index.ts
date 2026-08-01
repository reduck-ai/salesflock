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
//   5. CRM: the agent's entity table + a dual `config.entity` relation on the shared Decisions,
//      and one Prompt row per config.prompts spec — the row's Name must equal spec.name VERBATIM
//      (it is the join key `agentFor` resolves; a mismatch renders generic and never moves the
//      entity), columns Version / Input schema / Output schema / Proposal / Anchor field, page
//      body = the authored instructions.

import type { AgentConfig, PromptSpec } from "../src/stores/index.js";
import type { Quote } from "../src/anchor.js";
import redditEngage from "./reddit-engage/config.js";
import * as redditEngageEvidence from "./reddit-engage/evidence.js";

export interface Agent {
	config: AgentConfig;
	renderEvidence: (input: Record<string, string>) => string;
	fieldSpan: (input: Record<string, string>, key: string) => Quote | null;
}

const agent = (config: AgentConfig, ev: Omit<Agent, "config">): Agent => ({
	config,
	renderEvidence: ev.renderEvidence,
	fieldSpan: ev.fieldSpan
});

// id (the agents/<id>/ folder) → the agent. The CLI resolves --agent here; the app never uses ids.
export const AGENTS: Record<string, Agent> = {
	"reddit-engage": agent(redditEngage, redditEngageEvidence)
};

// kind (Prompt Name) → the one agent that declares it, plus the spec itself. Two agents declaring
// one kind would make a decision's semantics ambiguous — that's a config bug, failed at load.
const kinds = new Map<string, Agent & { spec: PromptSpec }>();
for (const a of Object.values(AGENTS))
	for (const spec of Object.values(a.config.prompts ?? {})) {
		if (kinds.has(spec.name)) throw new Error(`duplicate decision kind "${spec.name}" across agents`);
		kinds.set(spec.name, { ...a, spec });
	}

// The row's own resolver: a Decision's kind → the agent that judged it. undefined for a kind no
// agent declares today (a renamed prompt, a decommissioned agent) — the caller keeps such rows
// readable (generic rendering) but never moves their pipeline.
export const agentFor = (kind?: string): (Agent & { spec: PromptSpec }) | undefined =>
	kind ? kinds.get(kind) : undefined;

// Every declared kind — the review app's per-Prompt filter options, stable whatever is queued.
export const KINDS: string[] = [...kinds.keys()];
