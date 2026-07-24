// former-rpa-pms — the same CRM as linkedin-leads (shared tables), a clean 4-stage funnel for
// FORMER senior PMs of the RPA vendors. Bound here: the store, the table each model maps to, and
// the one judgment prompt. `sflock pull --agent former-rpa-pms` reads this to regenerate schema/*.ts;
// the runtime reads it to pick the store and address each table. The Output-schema/resolve match
// linkedin-leads' qualify, so the shared review app moves Leads unchanged.

import type { AgentConfig } from "../../src/stores/index.js";

export default {
	destination: "notion",
	models: {
		People: "180ff6c9-e29d-4853-adf5-754948a20fe4",
		Companies: "b9b4d7b7-884c-8368-80d9-070bdf14ef0f",
		Leads: "e976116e-fcf0-42d4-bc16-99fa9c801e1c",
		Sourcing: "028210ed-fc1f-40e1-ba7d-ea28f68ba6fe",
		Decisions: "eddcfaaf-e6f1-4cea-a112-2b9d98426eb4",
		Prompts: "942c4138-c9db-404c-9ae0-472f8edb0712"
	},
	entity: "Lead",
	prompts: {
		// The deterministic pre-qualify already proved they were a former senior PM at a vendor; this
		// judges only the SOFT ICP (customer exposure, US/India, entrepreneurial + active). Same
		// Output tier + resolve as linkedin-leads' qualify, so the shared review app is unchanged.
		qualify: {
			name: "Former RPA PM Qualification",
			pending: "Qualification pending approval",
			resolve: (o) =>
				o.tier === "Not qualified"
					? { status: "Not qualified", advances: false }
					: { status: "To engage", advances: true }
		}
	}
} as const satisfies AgentConfig;
