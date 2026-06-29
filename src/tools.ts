// Higher-level tools — wrap scripts, add logic, write to state. The only layer
// with behavior; everything else is data, plumbing, or taste.

import { scripts } from "./scripts.js";
import type { Runner } from "./run.js";
import type { Adapter, Lead } from "./adapter.js";

export const tools = (run: Runner, store: Adapter) => ({
	// Post URLs for a topic, newest first — Google over site:linkedin.com/posts
	// (a real recency filter, no LinkedIn rate cap).
	discover: (topic: string, limit: number) =>
		run(scripts.discover, { query: `site:linkedin.com/posts ${topic}`, limit }),

	// A post's content + author.
	post: (postUrl: string) => run(scripts.post, { postUrl }),

	// The engaged audience: who reacted (name + member-id profile link).
	reactors: (postUrl: string, limit: number) => run(scripts.reactors, { postUrl, limit }),

	// get_profile — the three profile calls (separate runs) + the account, then
	// write the assembled lead to state. get_profile resolves a member-id link to
	// the canonical profile, so the others key off its url.
	getProfile: async (profileUrl: string): Promise<Lead> => {
		const profile = (await run(scripts.profile, { profileUrl })) as Record<string, unknown>;
		const url = (profile.url as string | undefined) ?? profileUrl;
		const [experience, education] = await Promise.all([
			run(scripts.experience, { profileUrl: url }),
			run(scripts.education, { profileUrl: url })
		]);
		const companyUrl = profile.companyUrl as string | undefined;
		const company = companyUrl ? await run(scripts.company, { companyUrl }) : null;
		const lead: Lead = { profile, experience, education, company };
		await store.upsert(lead);
		return lead;
	}
});
