// LinkedIn (Lk) client — packages the LinkedIn flows that span several Reduck base
// scripts. Today: get_profile, the one composite a single `reduck run` can't express
// (three scripts threaded by publicId, assembled into one record). Pure composition
// over reduck.run — no persistence (the agent's tool writes to the CRM).

import { run, type Args } from "./reduck.js";
import { scripts } from "./lk.scripts.js";
import { scripts as google } from "./google.scripts.js";
import type { Search } from "./google.schema.js";
import type { Card, Experience, Education, Company } from "./lk.schema.js";

// LinkedIn's profile scripts key off publicId — the /in/<publicId> slug. Accept a
// full profile URL or a bare publicId.
export const publicIdOf = (profile: string): string => profile.match(/\/in\/([^/?]+)/)?.[1] ?? profile;

// The assembled profile — each field is its script's contract output (see lk.schema.ts).
export interface Profile {
	publicId: string;
	card: Card;
	experience: Experience;
	education: Education;
}

// A Google-discovered profile stub: the canonical identity every downstream stage joins
// on (publicId → normalized /in/ URL), plus the SERP's own rendering of the top card.
export interface ProfileHit {
	publicId: string;
	profileUrl: string;
	name: string;
	headline?: string;
	title: string;
	snippet: string;
}

// search_profiles — one Google run, filtered to /in/ results. The SERP title renders as
// "Name - Headline | LinkedIn"; the URL is normalized to https://www.linkedin.com/in/<publicId>
// so every stage upserts the same key. Returns script + args so the caller can persist
// provenance without knowing addresses.
export const searchProfiles = async (
	query: string,
	n?: number
): Promise<{ script: string; args: Args; hits: ProfileHit[] }> => {
	const args: Args = { query, ...(n ? { n } : {}) };
	const results = await run<Search>(google.search, args);
	const hits = results.flatMap((r) => {
		const publicId = r.url.match(/linkedin\.com\/in\/([^/?#]+)/)?.[1];
		if (!publicId) return [];
		const [name, ...rest] = r.title.replace(/\s*[|·-]\s*LinkedIn\s*$/i, "").split(" - ");
		return {
			publicId,
			profileUrl: `https://www.linkedin.com/in/${publicId}`,
			name: name.trim(),
			headline: rest.join(" - ").trim() || undefined,
			title: r.title,
			snippet: r.snippet
		};
	});
	return { script: google.search, args, hits };
};

// get_profile — the three profile calls (separate runs, threaded by publicId),
// assembled into one record.
export const getProfile = async (profile: string): Promise<Profile> => {
	const publicId = publicIdOf(profile);
	const [card, experience, education] = await Promise.all([
		run<Card>(scripts.card, { publicId }),
		run<Experience>(scripts.experience, { publicId, count: 50 }),
		run<Education>(scripts.education, { publicId })
	]);
	return { publicId, card, experience, education };
};

// get_company_info — a single run (no composition), but the Lk client owns it so the
// agent's tool speaks one client. Accepts a company URL or a bare slug (the script's own
// contract). Re-exports the Company type as the tool's persisted shape.
export type { Company };
export const getCompany = (company: string): Promise<Company> => run<Company>(scripts.company, { url: company });
