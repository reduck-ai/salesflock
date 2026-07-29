// lk-engage tools — the bare-minimum funnel:
//   scan   → discover from BOTH the People I Watch (their recent posts) AND my home feed, queueing
//            fresh (<48h) posts as Lk Engagements at "To qualify". Dedup between the two sources is
//            free: every engagement upserts on Post URL and the ladder is monotonic, so a watched
//            person who also shows in the feed converges to ONE row.
//   engage → decide("qualify") — the LLM gate (no deterministic pre-filter in this MVP) — and, if it
//            scores well, decide("comment") held behind it via dependsOn, so the review app hides
//            the draft until a human approves the qualification.
//   [human gate] → the review app commits the comment → "Approved" (posting is unwired).
// READ-ONLY: never posts to LinkedIn. Monotonic + idempotent on Post URL.

import { getFeedPosts, getProfilePosts, publicIdOf } from "../../src/clients/lk/index.js";
import { getStore } from "../../src/stores/index.js";
import { createDecider } from "../../src/decide.js";
import { renderEvidence } from "./evidence.js";
import { projectInput } from "../../src/project.js";
import { mapLimit } from "../../src/concurrency.js";
import { drain } from "../../src/drain.js";
import { stringify } from "yaml";
import config, { OWNER } from "./config.js";
import type { Subject } from "../../src/decide.js";
import type { PromptSpec } from "../../src/stores/index.js";
import type { Feed, Posts } from "../../src/clients/lk/index.js";
import type { LkEngagements } from "./schema/LkEngagements.js";

const store = getStore(config.destination);

// A short, single-line label from a post's text. Slices by CODE POINT (`[...s]`), never by code
// unit, so it can't cut an emoji's surrogate pair in half.
const label = (text: string, n = 60): string => [...text.replace(/\s+/g, " ").trim()].slice(0, n).join("");

// LinkedIn renders relative ages ("34m", "19h", "2d", "1w", "3mo", "1yr") — the only time signal the
// feeds give. Hours out, Infinity when unparseable (unparseable ⇒ not provably fresh ⇒ not queued).
const HOURS: Record<string, number> = { m: 1 / 60, h: 1, d: 24, w: 168, mo: 730, yr: 8760 };
export const ageHours = (postedAgo?: string | null): number => {
	const m = postedAgo?.trim().match(/^(\d+)\s*(mo|m|h|d|w|yr)/i);
	return m ? Number(m[1]) * HOURS[m[2].toLowerCase()] : Infinity;
};

// Fresh enough to be worth engaging: posted within the last `hours`. Comment threads move fast on
// LinkedIn; a stale post's audience has moved on.
const isFresh = (postedAgo?: string | null, hours = 48): boolean => ageHours(postedAgo) < hours;

// The one shape both discovery sources (a watched person's posts, the home feed) normalize to, so
// queueing is written once. `author` is the publicId — the identity key People rows derive from.
interface NormPost {
	url: string;
	author: string; // publicId
	authorName?: string | null;
	headline?: string | null;
	text: string;
	postedAgo?: string | null;
	reactions?: number;
	comments?: number;
	reposts?: number;
}

// A watched person's own posts: reposts are someone else's content (engage on the original author's
// row if the feed surfaces it), so only originals qualify. Counts render as strings here.
const fromProfilePost = (p: Posts["posts"][number], publicId: string, name?: string): NormPost | null =>
	p.repostedBy || !p.text
		? null
		: {
				url: p.postUrl,
				author: publicId,
				authorName: p.author ?? name,
				headline: p.headline,
				text: p.text,
				postedAgo: p.postedAgo,
				reactions: p.reactions ? Number(p.reactions) || undefined : undefined,
				comments: p.comments ? Number(p.comments) || undefined : undefined,
				reposts: p.reposts ? Number(p.reposts) || undefined : undefined
			};

// A home-feed post: needs a permalink AND a person author (/in/<id> — company pages aren't people we
// engage); ads and reposts are skipped.
const fromFeedPost = (p: Feed["posts"][number]): NormPost | null => {
	const publicId = p.authorProfileUrl?.match(/\/in\/([^/?#]+)/)?.[1];
	return p.isSponsored || p.isRepost || !p.postUrl || !p.text || !publicId
		? null
		: {
				url: p.postUrl,
				author: publicId,
				authorName: p.authorName,
				headline: p.headline,
				text: p.text,
				postedAgo: p.postedAgo,
				reactions: p.reactions || undefined,
				comments: p.comments || undefined,
				reposts: p.reposts || undefined
			};
};

// The Lk entity bridge (this agent's own wiring): the Lk Engagement row IS the subject — it carries
// the frozen post evidence projectInput reads — AND the pipeline entity the Decision binds to.
const resolveSubject = async (postUrl: string): Promise<Subject> => {
	const row = await store.read(config.models.LkEngagements, "Post URL", postUrl);
	return { key: postUrl, name: String(row.fields.Name ?? postUrl), fields: row.fields, ref: row.id };
};
const linkEntity = async (
	subject: Subject,
	spec: PromptSpec,
	{ dependsOn }: { dependsOn?: string[] }
): Promise<string> => {
	if (!dependsOn?.length)
		await store.upsert(
			config.models.LkEngagements,
			{ Name: subject.name, "Post URL": subject.key, Status: spec.pending },
			"Post URL"
		);
	return subject.ref as string;
};

const decider = createDecider({ config, store, renderEvidence, projectInput, resolveSubject, linkEntity });

// The funnel's forward order; a stage never drags an engagement backward. "Not qualified" is the
// terminal miss, off the ladder. "Approved" is terminal (nothing posts).
const LADDER: readonly string[] = config.ladder;
const rank = (s: string | null): number => (s ? LADDER.indexOf(s) : -1);

const statusOf = async (postUrl: string): Promise<string | null> => {
	const [e] = await store.query(config.models.LkEngagements, { property: "Post URL", url: { equals: postUrl } });
	return e ? String(e.fields.Status ?? "") : null;
};

// queue(p) — make (or refresh) the engagement candidate. Never queues the owner (you don't comment
// on yourself) or stale posts. Monotonic: "To qualify" is written only when the engagement hasn't
// already advanced (or terminally missed), so a re-run — or the same post arriving from both the
// watchlist and the feed — converges, never moves backward.
const queue = async (
	p: NormPost,
	ranAt: string
): Promise<{ url: string; author: string; queued: boolean; status: string | null; reason?: string; engagement?: string }> => {
	if (p.author.toLowerCase() === OWNER.toLowerCase())
		return { url: p.url, author: p.author, queued: false, status: null, reason: "owner" };
	if (!isFresh(p.postedAgo)) return { url: p.url, author: p.author, queued: false, status: null, reason: "stale" };
	const current = await statusOf(p.url);
	const advanced = current === "Not qualified" || rank(current) >= rank("To qualify");
	const row: LkEngagements = {
		Name: `@${p.author} — ${label(p.text)}`,
		"Post URL": p.url,
		Author: p.author,
		"Author name": p.authorName ?? p.author,
		// The evidence field: the focal post as lossless YAML, rendered by evidence.ts as a LinkedIn
		// card. The flat Author/Reach columns stay for the Notion table view; this is what the judge
		// and the review app render.
		Post: stringify(
			{
				name: p.authorName ?? p.author,
				publicId: p.author,
				url: p.url,
				headline: p.headline ?? undefined,
				age: p.postedAgo ?? undefined,
				text: p.text,
				reactions: p.reactions,
				comments: p.comments,
				reposts: p.reposts
			},
			{ lineWidth: 0 }
		),
		Reach: p.reactions,
		"Scanned at": ranAt,
		...(advanced ? {} : { Status: "To qualify" })
	};
	const e = await store.upsert(config.models.LkEngagements, row, "Post URL");
	return { url: p.url, author: p.author, queued: !advanced, status: advanced ? current : "To qualify", engagement: e.url };
};

export const tools = {
	// scan — the unified discovery: the recent posts of every Watched Person (the People table's
	// `Watch` checkbox) AND my home feed, queueing fresh candidates at "To qualify". Dedup across the
	// two sources is structural — Post URL + the monotonic guard. No LLM, no reply fetch.
	scan: async (count = 10) => {
		const watched = await store.query(config.models.People, { property: "Watch", checkbox: { equals: true } });
		const people = await mapLimit(watched, async (r) => {
			const publicId = publicIdOf(String(r.fields["LinkedIn URL"] ?? ""));
			if (!publicId) return { publicId: "", queued: [] };
			const ranAt = new Date().toISOString();
			const { posts } = await getProfilePosts(publicId, count);
			const norm = posts.map((p) => fromProfilePost(p, publicId, String(r.fields.Name ?? ""))).filter((p): p is NormPost => !!p);
			const results = await mapLimit(norm, (p) => queue(p, ranAt));
			return { publicId, seen: norm.length, queued: results.filter((x) => x.queued) };
		});
		const ranAt = new Date().toISOString();
		const feed = await getFeedPosts(count);
		const norm = feed.posts.map(fromFeedPost).filter((p): p is NormPost => !!p);
		const feedResults = await mapLimit(norm, (p) => queue(p, ranAt));
		return { people, feed: { seen: norm.length, queued: feedResults.filter((x) => x.queued) } };
	},

	// engage — the funnel: the LLM qualification, and — the moment it scores well — the comment
	// draft, bound to the qualification via `dependsOn` so the review app keeps it hidden until a
	// human approves (and drops it for good on "Not interesting"). Monotonic: no-ops once a
	// qualification is pending or beyond (and on the terminal "Not qualified"), so a re-run — or
	// engagePending — never double-drafts.
	engage: async (postUrl: string) => {
		const status = await statusOf(postUrl);
		if (status === "Not qualified" || rank(status) >= rank("Qualification pending review"))
			return { url: postUrl, skipped: true, status };
		const q = await decider.decide("qualify", postUrl);
		const good = config.prompts!.qualify.resolve(q.output).advances;
		const draft = good ? await decider.decide("comment", postUrl, { dependsOn: [q.id] }) : null;
		return { url: postUrl, stage: draft ? "drafted" : "qualified-out", qualify: q.id, draft: draft?.id };
	},

	// engagePending — drain `engage` over every engagement at "To qualify" (scan's output). Judging
	// advances a row out of the filter, so the drain pages any backlog with no cursor.
	engagePending: () =>
		drain(store, config.models.LkEngagements, { property: "Status", select: { equals: "To qualify" } }, (r) =>
			tools.engage(String(r.fields["Post URL"]))
		),

	// draft — manually (re-)draft a comment for one post as a STANDALONE Decision (no qualification
	// dependency), for a redraft after editing. `context` prints the frozen judgment context, writes nothing.
	draft: (postUrl: string) => decider.decide("comment", postUrl),
	context: (postUrl: string) => decider.context("comment", postUrl),

	// list / show — the review queue and one Decision, straight off the shared engine.
	list: () => decider.list(),
	show: (handle: string) => decider.showDecision(handle)
};
