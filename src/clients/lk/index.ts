// LinkedIn (Lk) client — packages the LinkedIn flows that span several Reduck base
// scripts. Today: get_profile, the one composite a single `reduck run` can't express
// (three scripts threaded by publicId, assembled into one record). Pure composition
// over reduck.run — no persistence (the agent's tool writes to the CRM).

import { run, type Args } from "../reduck.js";
import { scripts } from "./scripts.js";
import { scripts as google } from "../google/scripts.js";
import type { Search } from "../google/schema.js";
import type { Card, Experience, Posts, Comments, Company } from "./schema.js";

// LinkedIn's profile scripts key off publicId — the /in/<publicId> slug. Accept a
// full profile URL or a bare publicId.
export const publicIdOf = (profile: string): string =>
	profile.match(/\/in\/([^/?]+)/)?.[1] ?? profile;

// Best-effort run for the activity lens: posts/comments are enrichment, not identity, and
// their feeds are the slowest — a timeout there must never drop the whole profile. The
// error is explicitly silenced (logged, not thrown); the caller gets an empty result.
const tryRun = async <T>(addr: string, args: Args, fallback: T): Promise<T> => {
	try {
		return await run<T>(addr, args);
	} catch (e) {
		console.error(
			`activity ${addr} skipped (best-effort): ${(e as Error).message.split("\n")[0]}`
		);
		return fallback;
	}
};

// The assembled profile — each field is its script's contract output (see lk.schema.ts).
// posts/comments are the activity lens: what the person publishes and where they engage.
export interface Profile {
	publicId: string;
	card: Card;
	experience: Experience;
	posts: Posts;
	comments: Comments;
}

// A Google-discovered profile stub: the canonical identity every downstream stage joins
// on (publicId → normalized /in/ URL), with name/headline parsed from the SERP title.
export interface ProfileHit {
	publicId: string;
	profileUrl: string;
	name: string;
	headline?: string;
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
			headline: rest.join(" - ").trim() || undefined
		};
	});
	return { script: google.search, args, hits };
};

// get_profile — the profile calls threaded by publicId, assembled into one record. Core
// identity is card + experience, fetched together and fails loud. The activity lens (posts,
// comments — slow feeds) is best-effort, so a timeout yields empty instead of losing the
// whole profile.
export const getProfile = async (profile: string): Promise<Profile> => {
	const publicId = publicIdOf(profile);
	const [card, experience] = await Promise.all([
		run<Card>(scripts.card, { publicId }),
		run<Experience>(scripts.experience, { publicId, count: 50 })
	]);
	const [posts, comments] = await Promise.all([
		tryRun<Posts>(scripts.posts, { publicId, count: 10 }, { posts: [] }),
		tryRun<Comments>(scripts.comments, { publicId, count: 10 }, { comments: [] })
	]);
	return { publicId, card, experience, posts, comments };
};

// get_company_info — a single run (no composition), but the Lk client owns it so the
// agent's tool speaks one client. Accepts a company URL or a bare slug (the script's own
// contract). Re-exports the Company type as the tool's persisted shape.
export type { Company };
export const getCompany = (company: string): Promise<Company> =>
	run<Company>(scripts.company, { url: company });
