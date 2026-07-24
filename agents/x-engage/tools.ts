// x-engage tools — the clean funnel, mirroring the LinkedIn agents:
//   scan     → discover from BOTH the people we follow (hydrate every Approved X Person) AND the For
//              You feed, archiving everything we see and queueing the fresh candidates. Dedup between
//              the two sources is free: every X Engagement upserts on Post URL and the status ladder
//              is monotonic, so a followed person who also shows in the feed converges to ONE row.
//   qualify  → the DETERMINISTIC gate (signal.ts): did the tweet's author answer a commenter? → "To
//              engage" | "Not qualified" | defer. URL-agnostic, so a reply candidate qualifies too.
//   draft    → decide("reply") → ONE Decision (the shared judge+gate), grounded in the OWNER's voice.
//   [human gate] → the review app commits the reply → "Approved" (post is unwired).
//
// The archive (X Posts / X Replies) is now a record of EVERYONE we see — each row carries `Author`, so
// the owner's own rows (voice.ts filters Author == OWNER) stay separable from the people we merely
// record. That single column collapses the old update-posts/update-replies into `hydrate(OWNER)`.
// This agent is READ-ONLY: it never posts to X. Monotonic + idempotent on Post URL / Reply URL.

import {
	getPersonalFeed,
	getTweet,
	getUserPosts,
	getUserReplies,
	handleOf,
	tweetIdOf
} from "../../src/clients/x/index.js";
import { getStore } from "../../src/stores/index.js";
import { createDecider } from "../../src/decide.js";
import { renderEvidence } from "./evidence.js";
import { projectInput } from "../../src/project.js";
import { mapLimit } from "../../src/concurrency.js";
import { classify, disposition } from "./signal.js";
import { stringify } from "yaml";
import { voiceExamples } from "./voice.js";
import config, { OWNER } from "./config.js";
import type { Subject } from "../../src/decide.js";
import type { PromptSpec } from "../../src/stores/index.js";
import type { Feed, UserPosts, UserReplies } from "../../src/clients/x/schema.js";
import type { XEngagements } from "./schema/XEngagements.js";
import type { XPosts } from "./schema/XPosts.js";
import type { XReplies } from "./schema/XReplies.js";

const store = getStore(config.destination);

// A short, single-line label from a tweet's text. Slices by CODE POINT (`[...s]`), never by code
// unit, so it can't cut an emoji's surrogate pair in half — a lone surrogate is invalid JSON to the
// Notion write and would fail the whole upsert.
const label = (text: string, n = 60): string => [...text.replace(/\s+/g, " ").trim()].slice(0, n).join("");

// X's date format ("Fri May 29 02:06:57 +0000 2026") → an ISO string for a Notion date, or undefined
// when absent/unparseable (a bad date must not fail the whole write).
const iso = (s?: string | null): string | undefined => {
	const d = s ? new Date(s) : null;
	return d && !isNaN(d.getTime()) ? d.toISOString() : undefined;
};

// Fresh enough to be worth engaging: posted within the last `hours`. The ONE genuinely new gate this
// redesign adds — archiving records everything, but only fresh tweets become candidates.
const isFresh = (createdAt?: string | null, hours = 48): boolean => {
	const d = createdAt ? new Date(createdAt) : null;
	return !!d && !isNaN(d.getTime()) && Date.now() - d.getTime() < hours * 3_600_000;
};

// The one shape every source (feed, a person's posts, a person's replies) normalizes to, so archive +
// queue are written once and shared. `isReply` routes the archive (X Replies vs X Posts); `parentAuthor`
// is who a reply answered (X Replies' "Parent author"), distinct from `author` (who wrote it).
interface NormTweet {
	url: string;
	id: string;
	author: string;
	authorName?: string;
	text: string;
	createdAt?: string | null;
	views?: number;
	replyCount?: number;
	isReply: boolean;
	parentAuthor?: string;
}

const fromFeed = (t: Feed["tweets"][number]): NormTweet => ({
	url: t.url,
	id: t.id,
	author: t.author.handle,
	authorName: t.author.name,
	text: t.text,
	createdAt: t.created_at,
	views: t.views ?? undefined,
	replyCount: t.replies ?? undefined,
	isReply: !!t.in_reply_to,
	parentAuthor: t.in_reply_to?.author_handle ?? undefined
});

const fromUserPost = (p: UserPosts[number], author: string, authorName?: string): NormTweet => ({
	url: p.url,
	id: p.id,
	author,
	authorName,
	text: p.text,
	createdAt: p.created_at,
	views: p.views ?? undefined,
	replyCount: p.replies ?? undefined,
	isReply: false
});

const fromUserReply = (r: UserReplies[number], author: string, authorName?: string): NormTweet => ({
	url: r.url,
	id: r.id,
	author,
	authorName,
	text: r.text,
	createdAt: r.created_at,
	views: r.views ?? undefined,
	replyCount: r.replies ?? undefined,
	isReply: true,
	parentAuthor: r.in_reply_to?.author_handle ?? undefined
});

// The X entity bridge (this agent's own wiring): the X Engagement row IS the subject — it carries
// the frozen post evidence projectInput reads — AND the pipeline entity the Decision binds to.
const resolveSubject = async (postUrl: string): Promise<Subject> => {
	const row = await store.read(config.models.XEngagements, "Post URL", postUrl);
	return { key: postUrl, name: String(row.fields.Name ?? postUrl), fields: row.fields, ref: row.id };
};
const linkEntity = async (
	subject: Subject,
	spec: PromptSpec,
	{ dependsOn }: { dependsOn?: string[] }
): Promise<string> => {
	if (!dependsOn?.length)
		await store.upsert(
			config.models.XEngagements,
			{ Name: subject.name, "Post URL": subject.key, Status: spec.pending },
			"Post URL"
		);
	return subject.ref as string;
};

// The judge grounded in the owner's own voice (X Posts + X Replies) rather than prior Decisions.
const decider = createDecider({
	config,
	store,
	renderEvidence,
	projectInput,
	resolveSubject,
	linkEntity,
	renderExamples: voiceExamples
});

// The funnel's forward order; a stage never drags an engagement backward. "Not qualified" is the
// terminal miss, off the ladder. "Approved" is terminal (the agent is read-only — nothing posts, so
// there is no "Posted" state to model until reply_to_tweet is wired).
const LADDER = ["To qualify", "To engage", "Draft pending review", "Approved"] as const;
const rank = (s: string | null): number => (s ? LADDER.indexOf(s as (typeof LADDER)[number]) : -1);
type Entry = "To qualify" | "To engage";

const statusOf = async (postUrl: string): Promise<string | null> => {
	const [e] = await store.query(config.models.XEngagements, { property: "Post URL", url: { equals: postUrl } });
	return e ? String(e.fields.Status ?? "") : null;
};

// archive(t) — record any tweet we see, keyed on its own URL (replies → X Replies by Reply URL, posts
// → X Posts by Post URL). Always runs, for the owner too (that IS the voice corpus). No freshness gate:
// the archive is a complete record.
const archive = async (t: NormTweet): Promise<void> => {
	if (t.isReply) {
		const row: XReplies = {
			Name: label(t.text) || t.id,
			"Reply URL": t.url,
			Reply: t.text || undefined,
			"Parent author": t.parentAuthor ?? undefined,
			"Posted at": iso(t.createdAt),
			Source: "Scraped",
			Author: t.author
		};
		await store.upsert(config.models.XReplies, row, "Reply URL");
	} else {
		const row: XPosts = {
			Name: label(t.text) || t.id,
			"Post URL": t.url,
			Text: t.text || undefined,
			"Posted at": iso(t.createdAt),
			Views: t.views,
			Author: t.author
		};
		await store.upsert(config.models.XPosts, row, "Post URL");
	}
};

// The Approved handles (lowercased) — the manual allowlist of people we follow. They are pre-vetted,
// so they bypass the qualify signal entirely: always enter "To engage", and are never eliminated.
const approvedSet = async (): Promise<Set<string>> => {
	const rows = await store.query(config.models.XPeople, { property: "Approved", checkbox: { equals: true } });
	return new Set(rows.map((r) => String(r.fields.Handle ?? "").toLowerCase().replace(/^@/, "")).filter(Boolean));
};

// queue(t, known) — make (or refresh) the engagement candidate. Never queues the owner (you don't reply
// to yourself) or stale tweets. Entry depends only on whether the author is Approved (`known`):
//   Approved → "To engage" (pre-vetted; skips the signal) — and "Not qualified" is NOT terminal for
//     them, so a stale drop is rehabilitated back up. They never stay dropped.
//   everyone else → "To qualify" — a path that needs a crowd, so a reply-less post is skipped there.
// Monotonic: the entry Status is only written when the lead hasn't already advanced past it, so a
// re-run — or the same tweet arriving from both hydrate and the feed — converges, never moves backward.
const queue = async (
	t: NormTweet,
	known: Set<string>,
	ranAt: string
): Promise<{ url: string; author: string; queued: boolean; status: string | null; reason?: string; engagement?: string }> => {
	if (t.author.toLowerCase() === OWNER.toLowerCase())
		return { url: t.url, author: t.author, queued: false, status: null, reason: "owner" };
	if (!isFresh(t.createdAt)) return { url: t.url, author: t.author, queued: false, status: null, reason: "stale" };
	const approved = known.has(t.author.toLowerCase());
	const entry: Entry = approved ? "To engage" : "To qualify";
	if (!approved && !t.replyCount) return { url: t.url, author: t.author, queued: false, status: null, reason: "no-replies" };
	const current = await statusOf(t.url);
	const advanced = approved
		? rank(current) >= rank("To engage")
		: current === "Not qualified" || rank(current) >= rank("To qualify");
	const row: XEngagements = {
		Name: `@${t.author} — ${label(t.text)}`,
		"Post URL": t.url,
		Author: t.author,
		"Author name": t.authorName ?? t.author,
		// The evidence field: the focal post as lossless YAML (mirrors LinkedIn's Activity), so
		// evidence.ts:renderTweet can present it as an x.com card. The flat Author/Reach columns
		// stay for the Notion table view; this YAML is what the judge and the review app render.
		Post: stringify(
			{ name: t.authorName, handle: t.author, time: iso(t.createdAt)?.slice(0, 10), text: t.text, reach: t.views, replies: t.replyCount },
			{ lineWidth: 0 }
		),
		Reach: t.views,
		"Scanned at": ranAt,
		...(advanced ? {} : { Status: entry })
	};
	const e = await store.upsert(config.models.XEngagements, row, "Post URL");
	return { url: t.url, author: t.author, queued: !advanced, status: advanced ? current : entry, engagement: e.url };
};

// ingest — archive then (maybe) queue: the one path both discovery sources funnel through.
const ingest = async (t: NormTweet, known: Set<string>, ranAt: string) => {
	await archive(t);
	return queue(t, known, ranAt);
};

export const tools = {
	// hydrate — pull a person's own posts + replies, record ALL of them in the archive, and queue the
	// fresh ones as candidates. Since we only ever hydrate Approved people, their candidates enter "To
	// engage" (queue reads `known`). `hydrate(OWNER)` is the voice-corpus maintainer (records the owner's
	// rows, queues nothing — the self-guard in queue). `known` defaults to the Approved set for standalone
	// use; scan passes the set it already built. Idempotent.
	hydrate: async (handle: string, count = 30, name?: string, known?: Set<string>) => {
		const h = handleOf(handle);
		const set = known ?? (await approvedSet());
		const ranAt = new Date().toISOString();
		const [posts, replies] = await Promise.all([getUserPosts(h, count), getUserReplies(h, count)]);
		const tweets = [
			...posts.filter((p) => !p.is_retweet).map((p) => fromUserPost(p, h, name)),
			...replies.filter((r) => r.in_reply_to && !r.is_retweet).map((r) => fromUserReply(r, h, name))
		];
		const results = await mapLimit(tweets, (t) => ingest(t, set, ranAt));
		return { handle: h, archived: tweets.length, queued: results.filter((r) => r.queued) };
	},

	// scan — the unified discovery: hydrate every Approved X Person (the people we follow), then the For
	// You feed, archiving everything and queueing candidates. One entry rule everywhere (queue reads
	// `known`): an Approved author → "To engage" (pre-vetted, skips qualify), anyone else → "To qualify".
	// Dedup across the two sources is structural — Post URL + the monotonic guard.
	scan: async (count = 20) => {
		const approved = await store.query(config.models.XPeople, { property: "Approved", checkbox: { equals: true } });
		const known = new Set(
			approved.map((r) => String(r.fields.Handle ?? "").toLowerCase().replace(/^@/, "")).filter(Boolean)
		);
		const people = await mapLimit(approved, (r) => {
			const handle = String(r.fields.Handle ?? "").replace(/^@/, "");
			return handle
				? tools.hydrate(handle, count, String(r.fields.Name ?? handle), known)
				: Promise.resolve({ handle: "", archived: 0, queued: [] });
		});
		const ranAt = new Date().toISOString();
		const feed = await getPersonalFeed(count);
		const feedTweets = feed.tweets.filter((t) => !t.is_retweet).map(fromFeed);
		const feedResults = await mapLimit(feedTweets, (t) => ingest(t, known, ranAt));
		return { people, feed: { archived: feedTweets.length, queued: feedResults.filter((r) => r.queued) } };
	},

	// qualify — the deterministic gate (former-rpa-pms pre-qualify's analogue). No-ops once past qualify.
	// Otherwise ONE reply pull → classify: author answered a commenter? PASS ⇒ "To engage" (+store the
	// signal); data-backed MISS ⇒ "Not qualified" (+comment); INSUFFICIENT DATA (no replies, or a capped
	// pull that didn't see the whole thread) ⇒ left at "To qualify" to retry. No Decision, no LLM — the
	// slow LLM draft only runs on survivors. URL-agnostic: a reply candidate qualifies on its sub-thread.
	qualify: async (postUrl: string, replyDepth = 60, known?: Set<string>) => {
		const status = await statusOf(postUrl);
		if (status === "Not qualified" || rank(status) >= rank("To engage"))
			return { url: postUrl, skipped: true, status };
		const row = await store.read(config.models.XEngagements, "Post URL", postUrl);
		const author = String(row.fields.Author ?? "");
		const { replies, complete } = await getTweet(postUrl, replyDepth);
		// `complete` is the script's own drained-vs-capped flag; a capped read can't prove a negative, so it defers.
		const q = classify(author, tweetIdOf(postUrl), replies, complete);
		// An Approved author is pre-vetted — never eliminate them (belt-and-suspenders for a legacy row
		// stranded at "To qualify"); a miss just defers until scan promotes them to "To engage".
		const set = known ?? (await approvedSet());
		const eliminate = q.eliminate && !set.has(author.toLowerCase());
		const advance = q.pass ? "To engage" : eliminate ? "Not qualified" : null;
		const patch: XEngagements = {
			Name: String(row.fields.Name),
			"Post URL": postUrl,
			...(q.pass
				? {
						"Author engagement": stringify(
							{ author, exchanges: q.answered.map((a) => ({ replier: a.to.author?.handle, text: a.to.text, reply: a.opReply.text })) },
							{ lineWidth: 0 }
						)
					}
				: {}),
			...(advance ? { Status: advance } : {})
		};
		const e = await store.upsert(config.models.XEngagements, patch, "Post URL");
		if (eliminate) await store.comment(e.id, disposition(q, author));
		return { url: postUrl, author, pass: q.pass, eliminate, answered: q.answered.length, deferred: !advance, status: advance ?? status };
	},

	// qualifyPending — qualify every engagement still at "To qualify" (build the Approved set once).
	qualifyPending: async (replyDepth?: number) => {
		const known = await approvedSet();
		const rows = await store.query(config.models.XEngagements, { property: "Status", select: { equals: "To qualify" } });
		return mapLimit(rows, (r) => tools.qualify(String(r.fields["Post URL"]), replyDepth, known));
	},

	// draft — judge one engagement against the "X Reply" contract, grounded in the owner's voice;
	// writes one Decision and moves the engagement to the pending review gate. `context` prints the
	// frozen judgment context (contract + evidence + the voice block), writes nothing.
	draft: (postUrl: string) => decider.decide("reply", postUrl),
	context: (postUrl: string) => decider.context("reply", postUrl),

	// draftPending — draft every engagement at "To engage".
	draftPending: async () => {
		const rows = await store.query(config.models.XEngagements, { property: "Status", select: { equals: "To engage" } });
		return mapLimit(rows, (r) => decider.decide("reply", String(r.fields["Post URL"])));
	},

	// list / show — the review queue and one Decision, straight off the shared engine.
	list: () => decider.list(),
	show: (handle: string) => decider.showDecision(handle)
};
