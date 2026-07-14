// The one place this agent is bound to a store: which destination, which table each logical
// model maps to, and its named prompt rows. `sflock pull --agent linkedin-leads` reads this
// to regenerate schema/*.ts; the runtime reads it to pick the store and address each table.
// No secrets (ids are already public in the schema banners) — committed, like knowledge/.

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
	prompts: { qualify: "Lead Qualification" }
} satisfies AgentConfig;
