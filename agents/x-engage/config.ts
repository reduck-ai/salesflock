// x-engage — feed-driven X engagement. Binds to the shared CRM: its own pipeline table (X
// Engagements, the peer of Leads) plus the two universal tables every agent shares — Decisions
// (the judge+gate) and Prompts (the contracts). `sflock pull --agent x-engage` reads this to
// regenerate schema/*.ts; the runtime reads it to address each table and to pick the store.
//
// The draft is a real Decision (one judge engine, one review surface), so the "X Reply" Prompt row
// carries the contract (System/Instruction/Input+Output schema) and `resolve` maps the committed
// output onto the X Engagement's Status ladder — exactly as the LinkedIn agents' qualify does.

import type { AgentConfig } from "../../src/stores/index.js";

export default {
	destination: "notion",
	models: {
		Engagements: "f33193c0-a57d-43cc-900c-c399e1c1beda",
		Decisions: "eddcfaaf-e6f1-4cea-a112-2b9d98426eb4",
		Prompts: "942c4138-c9db-404c-9ae0-472f8edb0712"
	},
	prompts: {
		// The draft of a reply. The committed output IS the decision: `resolve` advances the
		// Engagement to "Approved" (the gate the `post` stage acts on). No negative branch — declining
		// to engage is simply not confirming (the row stays at the pending gate).
		reply: {
			name: "X Reply",
			pending: "Draft pending review",
			resolve: () => ({ status: "Approved", advances: true })
		}
	}
} as const satisfies AgentConfig;
