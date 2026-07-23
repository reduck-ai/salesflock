// x-engage tools — the clean funnel, mirroring the LinkedIn agents:
//   scan     → discover (feed) → X Engagement at "To qualify" (or straight to "To engage" if the
//              author is a known, Approved person in X People — the manual fast-path)
//   qualify  → the DETERMINISTIC gate (signal.ts): did the author answer a commenter? → "To engage"
//              | "Not qualified" | defer (stay "To qualify"). No LLM, no Decision — the pre-qualify analogue.
//   draft    → decide("reply") → ONE Decision (the shared judge+gate), grounded in the OWNER's voice
//              (X Posts + X Replies via voice.ts) → Engagement "Draft pending review"
//   [human gate] → the review app commits the reply → "Approved" (the terminal state; post is unwired)
//
// Plus the voice-corpus maintainers: update-posts (the owner's own posts) and update-replies (the
// owner's own replies — synced from validated/Approved drafts; manual rows coexist). This agent is
// READ-ONLY: it never posts to X. Monotonic + idempotent on Post URL, like the LinkedIn funnels.

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
import { renderEvidence } from "../../src/x/evidence.js";
import { projectInput } from "../../src/project.js";
import { mapLimit } from "../../src/concurrency.js";
import { classify, renderSignal, disposition } from "./signal.js";
import { voiceExamples } from "./voice.js";
import config from "./config.js";
import type { Subject, EntityLink } from "../../src/decide.js";
import type { PromptSpec } from "../../src/stores/index.js";
import type { Feed } from "../../src/clients/x/schema.js";
import type { XEngagements } from "./schema/XEngagements.js";
import type { XPosts } from "./schema/XPosts.js";
import type { XReplies } from "./schema/XReplies.js";

const store = getStore(config.destination);
type Post = Feed["tweets"][number];

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
): Promise<EntityLink> => {
	if (!dependsOn?.length)
		await store.upsert(
			config.models.XEngagements,
			{ Name: subject.name, "Post URL": subject.key, Status: spec.pending },
			"Post URL"
		);
	return { relation: "X Engagement", id: subject.ref as string };
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
// terminal miss, off the ladder. "Posted" is reserved (post is unwired) — "Approved" is terminal today.
const LADDER = ["To qualify", "To engage", "Draft pending review", "Approved", "Posted"] as const;
const rank = (s: string | null): number => (s ? LADDER.indexOf(s as (typeof LADDER)[number]) : -1);

const statusOf = async (postUrl: string): Promise<string | null> => {
	const [e] = await store.query(config.models.XEngagements, { property: "Post URL", url: { equals: postUrl } });
	return e ? String(e.fields.Status ?? "") : null;
};

export const tools = {
	// scan — For You feed → an X Engagement per candidate (author replied to someone, so a reply from
	// us can earn a response). A known, Approved author (X People) enters straight at "To engage",
	// skipping qualify; everyone else enters at "To qualify". Cheap: no per-post reply fetch, no LLM.
	// Monotonic: never drags an already-advanced engagement backward.
	scan: async (count = 20) => {
		const feed = await getPersonalFeed(count);
		const candidates = feed.tweets.filter((t: Post) => !t.is_retweet && t.reply_count > 0);
		const ranAt = new Date().toISOString();
		const approved = await store.query(config.models.XPeople, { property: "Approved", checkbox: { equals: true } });
		const known = new Set(
			approved.map((r) => String(r.fields.Handle ?? "").toLowerCase().replace(/^@/, "")).filter(Boolean)
		);
		return mapLimit(candidates, async (t: Post) => {
			const u = t.url;
			const handle = t.author.handle;
			const isKnown = known.has(handle.toLowerCase());
			const entry = isKnown ? "To engage" : "To qualify";
			const current = await statusOf(u);
			const advanced = current === "Not qualified" || rank(current) >= rank(entry);
			const row: XEngagements = {
				Name: `@${handle} — ${label(t.text)}`,
				"Post URL": u,
				Author: handle,
				"Author name": t.author.name,
				Post: t.text,
				Reach: t.view_count ?? undefined,
				"Scanned at": ranAt,
				...(advanced ? {} : { Status: entry })
			};
			const r = await store.upsert(config.models.XEngagements, row, "Post URL");
			return { url: u, author: handle, known: isKnown, status: advanced ? current : entry, engagement: r.url };
		});
	},

	// qualify — the deterministic gate (former-rpa-pms pre-qualify's analogue). No-ops once past qualify.
	// Otherwise ONE reply pull → classify: author answered a commenter? PASS ⇒ "To engage" (+store the
	// signal); data-backed MISS ⇒ "Not qualified" (+comment); INSUFFICIENT DATA (no replies) ⇒ left at
	// "To qualify" to retry. No Decision, no LLM — the slow LLM draft only runs on survivors.
	qualify: async (postUrl: string, replyDepth = 60) => {
		const status = await statusOf(postUrl);
		if (status === "Not qualified" || rank(status) >= rank("To engage"))
			return { url: postUrl, skipped: true, status };
		const row = await store.read(config.models.XEngagements, "Post URL", postUrl);
		const author = String(row.fields.Author ?? "");
		const { replies } = await getTweet(postUrl, replyDepth);
		const q = classify(author, tweetIdOf(postUrl), replies);
		const advance = q.pass ? "To engage" : q.eliminate ? "Not qualified" : null;
		const patch: XEngagements = {
			Name: String(row.fields.Name),
			"Post URL": postUrl,
			...(q.pass ? { "Author engagement": renderSignal(author, q.answered) } : {}),
			...(advance ? { Status: advance } : {})
		};
		const e = await store.upsert(config.models.XEngagements, patch, "Post URL");
		if (q.eliminate) await store.comment(e.id, disposition(q, author));
		return { url: postUrl, author, pass: q.pass, eliminate: q.eliminate, answered: q.answered.length, deferred: !advance, status: advance ?? status };
	},

	// qualifyPending — qualify every engagement still at "To qualify".
	qualifyPending: async (replyDepth?: number) => {
		const rows = await store.query(config.models.XEngagements, { property: "Status", select: { equals: "To qualify" } });
		return mapLimit(rows, (r) => tools.qualify(String(r.fields["Post URL"]), replyDepth));
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

	// update-posts — scrape the owner's OWN posts (Posts tab) into X Posts, the voice corpus. Reposts
	// are excluded (not the owner's words). Idempotent on Post URL.
	updatePosts: async (handle: string, count = 30) => {
		const posts = await getUserPosts(handle, count);
		return mapLimit(
			posts.filter((p) => !p.is_retweet),
			async (p) => {
				const views = p.views != null ? Number(String(p.views).replace(/[^0-9]/g, "")) || undefined : undefined;
				const row: XPosts = {
					Name: label(p.text) || p.id,
					"Post URL": p.url,
					Text: p.text || undefined,
					"Posted at": iso(p.created_at),
					Views: views
				};
				const r = await store.upsert(config.models.XPosts, row, "Post URL");
				return { url: p.url, created: r.created };
			}
		);
	},

	// update-replies — scrape the owner's OWN replies (Replies tab, /with_replies) into X Replies, the
	// voice corpus. Keeps only rows that are actually replies (in_reply_to_handle set), keyed on the
	// reply's own URL. The parent post's text isn't in this feed (a get_tweet per reply would fetch
	// it) — the reply text + who it answered is the voice signal we need. Idempotent.
	updateReplies: async (handle: string, count = 30) => {
		const rows = await getUserReplies(handle, count);
		return mapLimit(
			rows.filter((r) => r.in_reply_to_handle),
			async (r) => {
				const row: XReplies = {
					Name: label(r.text) || r.id,
					"Reply URL": r.url,
					Reply: r.text,
					"Parent author": r.in_reply_to_handle ?? undefined,
					"Posted at": iso(r.created_at),
					Source: "Scraped"
				};
				const rr = await store.upsert(config.models.XReplies, row, "Reply URL");
				return { url: r.url, inReplyTo: r.in_reply_to_handle, created: rr.created };
			}
		);
	},

	// list / show — the review queue and one Decision, straight off the shared engine.
	list: () => decider.list(),
	show: (handle: string) => decider.showDecision(handle)
};
