// reddit-engage — subreddit-driven Reddit engagement, the Reddit sibling of lk-engage:
//   scan [ the watched subreddits' new threads → qualify (LLM, title + post) → reply draft (LLM,
//   dependsOn) in parallel ] → [human gate]. READ-ONLY — nothing is ever posted to Reddit.
// One pipeline table (Reddit Threads, the peer of Lk Engagements) + the two universal tables every
// agent shares (Decisions, Prompts). No People table: the thread IS the unit, its author a flat
// column. `sflock pull --agent reddit-engage` reads this to regenerate schema/*.ts; the runtime
// reads it to address each table.

import type { AgentConfig } from "../../src/stores/index.js";

// The watchlist — which subreddits `hydrate` scans (r/ prefix optional). A const, not a table:
// adding one is a one-line commit; lift into the CRM only when someone non-technical must edit it.
export const SUBREDDITS = ["AI_Agents", "openclaw", "automation", "mcp"] as const;

// Our own Reddit username: hydrate never queues our own threads (you don't reply to yourself).
// Empty ⇒ the check is off until filled in.
export const OWNER: string = "";

export default {
	destination: "notion",
	models: {
		RedditThreads: "287eec98-859f-4a64-a50d-75da2e965488",
		Decisions: "eddcfaaf-e6f1-4cea-a112-2b9d98426eb4",
		Prompts: "942c4138-c9db-404c-9ae0-472f8edb0712"
	},
	entity: "Reddit Thread",
	// Flash, not Sonnet: the judgments here are cheap relevance gates ahead of a human review, the
	// fan-out is wide, and this account's Bedrock TPS throttles at even 2 concurrent (measured).
	model: "google/gemini-3.5-flash",
	// The forward ladder — declared once here, obeyed by the runtime's stages (tools.ts) AND by the
	// review app's commit, so neither can move a thread backward. "Not qualified" is off it:
	// terminal, only reachable through a non-advancing decision.
	ladder: ["To qualify", "Qualification pending review", "To engage", "Draft pending review", "Approved"],
	prompts: {
		// Is this thread worth answering? The one gate of the funnel (no deterministic pre-filter).
		// Its committed output IS the decision: "Not interesting" is the terminal miss (non-advancing,
		// so the review app archives any reply drafted against it); the other tiers advance.
		qualify: {
			name: "Reddit Thread Qualification",
			pending: "Qualification pending review",
			resolve: (o) =>
				o.tier === "Not interesting"
					? { status: "Not qualified", advances: false }
					: { status: "To engage", advances: true }
		},
		// The reply draft, held behind the qualification via dependsOn. The committed output IS the
		// decision: `resolve` advances to "Approved" (the terminal gate — posting is unwired). No
		// negative branch: declining to engage is simply not confirming.
		reply: {
			name: "Reddit Reply",
			pending: "Draft pending review",
			resolve: (_output) => ({ status: "Approved", advances: true })
		}
	}
} as const satisfies AgentConfig;
