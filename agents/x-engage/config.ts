// x-engage — feed-driven X engagement, a clean funnel that mirrors the LinkedIn agents:
//   scan → qualify (deterministic) → draft → [human gate].  Binds to the shared CRM: its own
// pipeline/backlog table (X Engagements, the peer of Leads) + the owner's voice corpus (X Posts,
// X Replies) that grounds the drafter + a manual fast-path allowlist (X People) + the two universal
// tables every agent shares (Decisions, Prompts). Model keys are 1:1 with the Notion table titles
// (space-collapsed, since a TS identifier can't hold the space). `sflock pull --agent x-engage`
// reads this to regenerate schema/*.ts; the runtime reads it to address each table and pick the store.
//
// The draft is a real Decision (one judge engine, one review surface), so the "X Reply" Prompt row
// carries the contract (System/Instruction/Input+Output schema) and `resolve` maps the committed
// output onto the Backlog's Status ladder — exactly as the LinkedIn agents' qualify does. Posting
// (reply_to_tweet) is intentionally NOT wired: this agent is read-only, it stops at the human gate.

import type { AgentConfig } from "../../src/stores/index.js";

// The owner's X handle (bare, no @). The one thing that separates "us" from "everyone else" in the
// now-shared archive: voice.ts filters X Posts/X Replies to Author == OWNER (drafts sound like the
// owner, not the people we record), and the ingest core never queues the owner's own tweets as
// engagement candidates (you don't reply to yourself).
export const OWNER = "dhuynh95";

export default {
	destination: "notion",
	models: {
		XEngagements: "f33193c0-a57d-43cc-900c-c399e1c1beda",
		XPosts: "895ce048-10e7-43f9-bd4f-7ff72a74ca05",
		XReplies: "88be9bab-eac8-4d6b-8a43-e0983c815728",
		XPeople: "c93447b2-1c17-484d-a3c6-caef8893418c",
		Decisions: "eddcfaaf-e6f1-4cea-a112-2b9d98426eb4",
		Prompts: "942c4138-c9db-404c-9ae0-472f8edb0712"
	},
	entity: "X Engagement",
	prompts: {
		// The draft of a reply, grounded in the owner's own Posts+Replies voice. The committed output
		// IS the decision: `resolve` advances the Backlog to "Approved" (the terminal gate, since post
		// is unwired). No negative branch — declining to engage is simply not confirming.
		reply: {
			name: "X Reply",
			pending: "Draft pending review",
			resolve: (_output) => ({ status: "Approved", advances: true })
		}
	}
} as const satisfies AgentConfig;
