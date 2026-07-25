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
import { parse, stringify } from "yaml";
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
// queue are written once and shared. `isReply` routes the archive (X Replies vs X Posts); `replyTo`
// is the answered tweet {id, handle} (X Replies' "Parent author" + the reply-context ref), and
// `quoted` the quoted tweet {id, handle} — both distinct from `author` (who wrote this tweet).
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
	replyTo?: { id: string; handle?: string }; // the tweet this one answers (a reply)
	quoted?: { id: string; handle?: string }; // the tweet this one quotes (a quote-tweet; feed only)
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
	replyTo: t.in_reply_to ? { id: t.in_reply_to.id, handle: t.in_reply_to.author_handle ?? undefined } : undefined,
	quoted: t.quoted_tweet ? { id: t.quoted_tweet.id, handle: t.quoted_tweet.author_handle ?? undefined } : undefined
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
	replyTo: r.in_reply_to ? { id: r.in_reply_to.id, handle: r.in_reply_to.author_handle ?? undefined } : undefined
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
// there is no "Posted" state to model until reply_to_tweet is wired). "Qualification pending review"
// is the qualify Decision's gate — reached by everyone the signal passes, before the reply is drafted.
// It lives in config.ts because the review app's commit obeys the same ladder: one declaration, both
// consumers, so a human Confirm can no more regress an engagement than a stage can.
const LADDER: readonly string[] = config.ladder;
const rank = (s: string | null): number => (s ? LADDER.indexOf(s) : -1);

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
			"Parent author": t.replyTo?.handle ?? undefined,
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

// queue(t, known) — make (or refresh) the engagement candidate. Never queues the owner (you don't
// reply to yourself) or stale tweets. Everyone enters the funnel at "To qualify"; `engage` fast-paths
// Approved authors past the signal + qualify gates at engage time. A reply-less post gives the signal
// nothing to read, so it's skipped — UNLESS the author is Approved (pre-vetted, bypasses the signal).
// Monotonic: "To qualify" is written only when the engagement hasn't already advanced, so a re-run —
// or the same tweet arriving from both hydrate and the feed — converges, never moves backward. A
// stale "Not qualified" is rehabilitated to "To qualify" for an Approved author (never terminally
// out), but stays put for everyone else (an evidence-backed elimination is terminal).
const queue = async (
	t: NormTweet,
	known: Set<string>,
	ranAt: string
): Promise<{ url: string; author: string; queued: boolean; status: string | null; reason?: string; engagement?: string }> => {
	if (t.author.toLowerCase() === OWNER.toLowerCase())
		return { url: t.url, author: t.author, queued: false, status: null, reason: "owner" };
	if (!isFresh(t.createdAt)) return { url: t.url, author: t.author, queued: false, status: null, reason: "stale" };
	const approved = known.has(t.author.toLowerCase());
	if (!approved && !t.replyCount) return { url: t.url, author: t.author, queued: false, status: null, reason: "no-replies" };
	const current = await statusOf(t.url);
	const advanced = approved
		? rank(current) >= rank("To qualify")
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
			{
				name: t.authorName,
				handle: t.author,
				time: iso(t.createdAt)?.slice(0, 10),
				text: t.text,
				reach: t.views,
				replies: t.replyCount,
				// The reply/quote context, as a {id, handle} ref only — captured free here at scan; `draft`
				// fills the real body via one get_tweet before judging (1:1 with x.com, only for survivors).
				...(t.replyTo ? { parent: { id: t.replyTo.id, handle: t.replyTo.handle } } : {}),
				...(t.quoted ? { quoted: { id: t.quoted.id, handle: t.quoted.handle } } : {})
			},
			{ lineWidth: 0 }
		),
		Reach: t.views,
		"Scanned at": ranAt,
		...(advanced ? {} : { Status: "To qualify" })
	};
	const e = await store.upsert(config.models.XEngagements, row, "Post URL");
	return { url: t.url, author: t.author, queued: !advanced, status: advanced ? current : "To qualify", engagement: e.url };
};

// ingest — archive then (maybe) queue: the one path both discovery sources funnel through.
const ingest = async (t: NormTweet, known: Set<string>, ranAt: string) => {
	await archive(t);
	return queue(t, known, ranAt);
};

// A tweet URL from a {id, handle} ref — the counterpart of a reply/quote (x.com/<handle>/status/<id>).
const counterpartUrl = (ref: { id: string; handle?: string }): string =>
	`https://x.com/${ref.handle ?? "i"}/status/${ref.id}`;

type Ctx = { id?: string; handle?: string; text?: string; [k: string]: unknown };

// ensureContext(postUrl) — 1:1 fidelity for the draft: any reply/quote context still holding only a
// {id, handle} ref (captured free at scan) is filled with the counterpart's REAL body via one get_tweet,
// then persisted back into the frozen Post so the judge and the review app render the actual x.com card.
// Lazy — only leads that reach the draft stage pay the fetch (don't enrich what you won't use).
// Idempotent: a ref that already carries text is left untouched.
const ensureContext = async (postUrl: string): Promise<void> => {
	const row = await store.read(config.models.XEngagements, "Post URL", postUrl);
	let post: Record<string, unknown>;
	try {
		post = parse(String(row.fields.Post ?? ""));
	} catch {
		return;
	}
	if (!post || typeof post !== "object") return;
	let changed = false;
	for (const slot of ["parent", "quoted"] as const) {
		const ref = post[slot] as Ctx | undefined;
		if (!ref?.id || ref.text) continue;
		const { tweet } = await getTweet(counterpartUrl({ id: ref.id, handle: ref.handle }), 1);
		if (!tweet) continue;
		post[slot] = {
			name: tweet.author?.name ?? undefined,
			handle: tweet.author?.handle ?? ref.handle,
			time: iso(tweet.created_at)?.slice(0, 10),
			text: tweet.text,
			reach: tweet.views ?? undefined,
			replies: tweet.replies ?? undefined
		};
		changed = true;
	}
	if (changed)
		await store.upsert(
			config.models.XEngagements,
			{ Name: String(row.fields.Name), "Post URL": postUrl, Post: stringify(post, { lineWidth: 0 }) },
			"Post URL"
		);
};

// GATE 1 — the deterministic pre-filter (signal.ts): does a crowd exist and does the author answer
// its repliers? On a pass it stores the answered exchanges as the evidence the qualify judge reads and
// returns `pass` (spend the LLM); an evidence-backed miss eliminates here (terminal "Not qualified" +
// comment); a thin/capped read defers (nothing written — the engagement stays "To qualify" to retry).
// It no longer advances the funnel — that's the qualify Decision's job. Approved authors never reach it.
const preFilter = async (
	postUrl: string,
	name: string,
	author: string,
	known: Set<string>,
	replyDepth = 60
): Promise<{ pass: boolean; eliminate: boolean; answered: number }> => {
	const { replies, complete } = await getTweet(postUrl, replyDepth);
	const q = classify(author, tweetIdOf(postUrl), replies, complete);
	const eliminate = q.eliminate && !known.has(author.toLowerCase());
	if (q.pass) {
		const patch: XEngagements = {
			Name: name,
			"Post URL": postUrl,
			"Author engagement": stringify(
				{ author, exchanges: q.answered.map((a) => ({ replier: a.to.author?.handle, text: a.to.text, reply: a.opReply.text })) },
				{ lineWidth: 0 }
			)
		};
		await store.upsert(config.models.XEngagements, patch, "Post URL");
	} else if (eliminate) {
		const e = await store.upsert(config.models.XEngagements, { Name: name, "Post URL": postUrl, Status: "Not qualified" }, "Post URL");
		await store.comment(e.id, disposition(q, author));
	}
	return { pass: q.pass, eliminate, answered: q.answered.length };
};

// (Re-)draft one reply as a Decision — enrich the reply/quote context first (1:1 x.com fidelity), then
// judge in the owner's voice. `dependsOn` binds it to a qualification so the review app holds it until
// that qualification is human-approved; standalone (undefined) when the author is pre-vetted.
const draftReply = (postUrl: string, dependsOn?: string[]) =>
	ensureContext(postUrl).then(() => decider.decide("reply", postUrl, dependsOn ? { dependsOn } : {}));

export const tools = {
	// hydrate — pull a person's own posts + replies, record ALL of them in the archive, and queue the
	// fresh ones as candidates at "To qualify" (`engage` fast-paths Approved authors past the gates at
	// engage time). `hydrate(OWNER)` is the voice-corpus maintainer (records the owner's
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
	// You feed, archiving everything and queueing candidates at "To qualify". `engage` later fast-paths
	// Approved authors past the signal + qualify gates. Dedup across the two sources is structural —
	// Post URL + the monotonic guard.
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

	// engage — the merged funnel: walk one post through the three gates in a single call, stopping at
	// the first that closes. Approved (pre-vetted) authors skip gates 1-2 and go straight to a standalone
	// draft; everyone else must clear the deterministic signal (gate 1), then the LLM qualification
	// (gate 2 — a Decision), before a reply is drafted (gate 3). The reply is created the moment the AI
	// qualifies the post ("if it scores well, draft"), but bound to the qualification via `dependsOn`, so
	// the review app keeps it hidden until a human approves the qualification — and drops it for good if
	// they instead mark the post "Not interesting". Monotonic: no-ops once a qualification is pending or
	// beyond (and on the terminal "Not qualified"), so a re-run — or engagePending — never double-drafts.
	engage: async (postUrl: string, known?: Set<string>) => {
		const status = await statusOf(postUrl);
		if (status === "Not qualified" || rank(status) >= rank("Qualification pending review"))
			return { url: postUrl, skipped: true, status };
		const row = await store.read(config.models.XEngagements, "Post URL", postUrl);
		const name = String(row.fields.Name ?? postUrl);
		const author = String(row.fields.Author ?? "");
		const set = known ?? (await approvedSet());
		const approved = set.has(author.toLowerCase());

		let qualify: string | undefined;
		let good = true;
		if (!approved) {
			const pf = await preFilter(postUrl, name, author, set);
			if (!pf.pass) return { url: postUrl, author, stage: pf.eliminate ? "eliminated" : "deferred", answered: pf.answered };
			const q = await decider.decide("qualify", postUrl);
			qualify = q.id;
			good = config.prompts!.qualify.resolve(q.output).advances;
		}
		const draft = good ? await draftReply(postUrl, qualify ? [qualify] : undefined) : null;
		return { url: postUrl, author, stage: draft ? "drafted" : "qualified-out", qualify, draft: draft?.id };
	},

	// engagePending — run `engage` over every engagement at "To qualify" (scan's output), building the
	// Approved set once. Replaces the old qualifyPending + draftPending: one pass, one place.
	engagePending: async () => {
		const known = await approvedSet();
		const rows = await store.query(config.models.XEngagements, { property: "Status", select: { equals: "To qualify" } });
		return mapLimit(rows, (r) => tools.engage(String(r.fields["Post URL"]), known));
	},

	// draft — manually (re-)draft a reply for one post as a STANDALONE Decision (no qualification
	// dependency), for a redraft after editing. `context` prints the frozen judgment context (contract +
	// evidence + the voice block), writes nothing.
	draft: (postUrl: string) => draftReply(postUrl),
	context: (postUrl: string) => decider.context("reply", postUrl),

	// list / show — the review queue and one Decision, straight off the shared engine.
	list: () => decider.list(),
	show: (handle: string) => decider.showDecision(handle)
};
