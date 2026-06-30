// The one tool that earns a TS layer — it does what `reduck run` alone can't:
// compose several base-script calls and write the result to the record store.
// Single base-script calls have no wrapper; the agent runs them via `reduck run`.

import { run } from "../../src/clients/reduck.js";
import type { Adapter, Lead } from "./store.js";

// LinkedIn's profile scripts key off publicId — the /in/<publicId> slug. Accept a
// full profile URL or a bare publicId.
const publicIdOf = (profile: string): string => profile.match(/\/in\/([^/?]+)/)?.[1] ?? profile;

export const tools = (store: Adapter) => ({
	// get_profile — the three profile calls (separate runs, threaded by publicId),
	// assembled into one lead and written to state.
	getProfile: async (profile: string): Promise<Lead> => {
		const publicId = publicIdOf(profile);
		const [card, experience, education] = await Promise.all([
			run("reduck/linkedin.com/get_profile", { publicId }),
			run("reduck/linkedin.com/get_profile_experience", { publicId, count: 50 }),
			run("reduck/linkedin.com/get_profile_education", { publicId })
		]);
		const lead: Lead = { publicId, card, experience, education };
		await store.upsert(lead);
		return lead;
	}
});
