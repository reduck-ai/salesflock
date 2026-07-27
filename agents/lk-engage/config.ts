// lk-engage — feed-driven LinkedIn engagement, the bare-minimum sibling of x-engage:
//   scan [ my home feed + the People I Watch ] → engage [ qualify (LLM) → comment draft (LLM,
//   dependsOn) ] → [human gate]. READ-ONLY — nothing is ever posted to LinkedIn.
// One pipeline table (Lk Engagements, the peer of X Engagements) + the shared People table as the
// watchlist (its `Watch` checkbox) + the two universal tables every agent shares (Decisions,
// Prompts). No archive, no deterministic signal, no live voice corpus in this MVP: the LLM qualify
// IS the gate, and the Lk Comment prompt body carries curated voice examples. `sflock pull --agent
// lk-engage` reads this to regenerate schema/*.ts; the runtime reads it to address each table.

import type { AgentConfig } from "../../src/stores/index.js";

// The owner's LinkedIn publicId (the /in/<publicId> slug). The one thing that separates "us" from
// "everyone else": scan never queues the owner's own posts (you don't comment on yourself).
export const OWNER = "dhuynh95";

export default {
	destination: "notion",
	models: {
		LkEngagements: "8058e760-5510-46e4-855b-18d82282a21a",
		People: "180ff6c9-e29d-4853-adf5-754948a20fe4",
		Decisions: "eddcfaaf-e6f1-4cea-a112-2b9d98426eb4",
		Prompts: "942c4138-c9db-404c-9ae0-472f8edb0712"
	},
	entity: "Lk Engagement",
	model: "bedrock/us.anthropic.claude-sonnet-4-6",
	// The forward ladder — declared once here, obeyed by the runtime's stages (tools.ts) AND by the
	// review app's commit, so neither can move an Lk Engagement backward. "Not qualified" is off it:
	// terminal, only reachable through a non-advancing decision.
	ladder: ["To qualify", "Qualification pending review", "To engage", "Draft pending review", "Approved"],
	prompts: {
		// Is this post worth a comment? The one gate of the MVP funnel (no deterministic pre-filter).
		// Its committed output IS the decision: "Not interesting" is the terminal miss (non-advancing,
		// so the review app archives any comment drafted against it); High/Medium advance.
		qualify: {
			name: "Lk Post Qualification",
			pending: "Qualification pending review",
			resolve: (o) =>
				o.tier === "Not interesting"
					? { status: "Not qualified", advances: false }
					: { status: "To engage", advances: true }
		},
		// The comment draft, in Daniel's register (curated examples live in the prompt body). The
		// committed output IS the decision: `resolve` advances to "Approved" (the terminal gate —
		// posting is unwired). No negative branch: declining to engage is simply not confirming.
		comment: {
			name: "Lk Comment",
			pending: "Draft pending review",
			resolve: (_output) => ({ status: "Approved", advances: true })
		}
	}
} as const satisfies AgentConfig;
