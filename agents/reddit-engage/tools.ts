// reddit-engage tools — the funnel, the lk-engage shape (fetch and judge are separate stages;
// the store IS the queue between them — "To qualify" is the worklist, not an in-memory list):
//   scan   → each watched subreddit's NEW threads (one listing run each — the listing's `body` is
//            the post's FULL text, so discovery already carries the evidence; no per-thread fetch
//            exists in this agent), queued as Reddit Threads at "To qualify". No LLM.
//   engage → qualify (LLM) as a JUDGMENT, not a Decision — the prompt is calibrated against
//            reddit_qualified_threads.yaml, so nobody rules on it and minting a Decision would only
//            be noise in the human's queue. Its whole record is the thread's Tier + Status plus a
//            comment on the thread page. It reads TWICE on growing evidence, one prompt both times:
//            the post alone (cheap, drops most threads with no fetch), then — only for a survivor —
//            the thread's own page via `refresh`, because an OP volunteers under their post what
//            the post never says ("I'm a broke student"). → if it still advances, a reply draft
//            (the one Decision) lands in the review queue. No args ⇒ drain the backlog.
//   [human gate] → ONLY the reply drafts: confirming one moves the thread to "Approved" (sending
//            is unwired); a "No" qualification terminally parks the thread at "Not qualified".
// The LADDER IS THE RESUME POINT: "To qualify" = scanned, "To engage" = qualified but not drafted,
// so `engage` reads the rung and does only what is left. That rung is persisted deliberately —
// flash is not run-stable on borderline threads, so re-judging after a crash could flip a T2 to
// "No" and, because the ladder is monotonic, freeze that false negative forever.
// READ-ONLY: never posts to Reddit. Monotonic + idempotent on the canonical Thread URL.

import { getSubredditThreads, getThread, threadUrl } from "../../src/clients/reddit/index.js";
import { getStore, queryAll } from "../../src/stores/index.js";
import { createDecider } from "../../src/decide.js";
import { renderEvidence } from "./evidence.js";
import { projectInput } from "../../src/project.js";
import { mapLimit } from "../../src/concurrency.js";
import { drain } from "../../src/drain.js";
import { parse, stringify } from "yaml";
import config, { SUBREDDITS, OWNER, subKey } from "./config.js";
import type { Subject, Verdict } from "../../src/decide.js";
import type { PromptSpec, Row } from "../../src/stores/index.js";
import type { Threads } from "../../src/clients/reddit/index.js";
import type { RedditThreads } from "./schema/RedditThreads.js";

const store = getStore(config.destination);

// A short, single-line label from a thread's title. Slices by CODE POINT (`[...s]`), never by code
// unit, so it can't cut an emoji's surrogate pair in half.
const label = (text: string, n = 60): string =>
	[...text.replace(/\s+/g, " ").trim()].slice(0, n).join("");

const nameOf = (subreddit: string, title: string): string => `r/${subreddit} — ${label(title)}`;

// The Reddit entity bridge (this agent's own wiring): the Reddit Thread row IS the subject — it
// carries the frozen Thread evidence projectInput reads — AND the pipeline entity the Decision
// binds to.
//
// One field is JOINED rather than read: the community's rules (config.ts), which belong to the
// subreddit, not the thread. Joining them here — instead of storing a copy on every thread row —
// keeps one place to declare them, and they still land in the Decision's frozen Input (so the review
// app renders them and the drafter can cite one), because that freeze is of the projected fields, not
// of the row. A prompt whose Input schema doesn't name "Subreddit rules" simply never sees them.
// subjectOf(url, row) — the pure half: a thread row → the Subject a judgment reads. Split out so a
// caller that already holds the row (engage, for its funnel guard) never pays to read it twice —
// `decide` takes either a key or a Subject.
const subjectOf = (url: string, row: Row): Subject => {
	const rules = SUBREDDITS[subKey(String(row.fields.Subreddit ?? ""))];
	return {
		key: url,
		name: String(row.fields.Name ?? url),
		fields: { ...row.fields, ...(rules ? { "Subreddit rules": rules } : {}) },
		ref: row.id
	};
};
const readThread = (url: string): Promise<Row> =>
	store.read(config.models.RedditThreads, "Thread URL", threadUrl(url));

// The frozen Thread seed, parsed. null when the field is absent or not the shape `queue` writes —
// the same tolerance evidence.ts's renderer has. Exported because a caller that wants to know what
// CHANGED across a `refresh` (did the OP answer us?) diffs two of these; the store holds the
// before, refresh returns the after.
export interface Seed {
	comments?: {
		author?: string | null;
		body?: string | null;
		score?: number | null;
		depth?: number | null;
		created?: string | null;
	}[];
	[k: string]: unknown;
}
export const seedOf = (row: Row): Seed | null => {
	try {
		return (parse(String(row.fields.Thread ?? "")) as Seed | null) ?? null;
	} catch {
		return null;
	}
};

// Has this thread's comment tree ever been fetched? Keyed on the PRESENCE of the seed's `comments`
// key, never on its length — the two negatives are different facts and must not fuse: `comments: []`
// is "we looked, nobody replied" (judged, done), an absent key is "we never looked" (not judged at
// all). Read length instead and every quiet thread is re-fetched forever, and worse, a verdict made
// on a genuinely empty tree becomes indistinguishable from one made on no evidence.
const hasCommentTree = (row: Row): boolean => Array.isArray(seedOf(row)?.comments);

const tierOf = (v: Verdict): string => String((v.output as { tier?: unknown }).tier ?? "");
const resolveSubject = async (url: string): Promise<Subject> =>
	subjectOf(url, await readThread(url));

const linkEntity = async (
	subject: Subject,
	spec: PromptSpec,
	{ dependsOn }: { dependsOn?: string[] }
): Promise<string> => {
	// A held dependent leaves Status alone — its gate has not been ruled on yet.
	if (!dependsOn?.length)
		await store.upsert(
			config.models.RedditThreads,
			{ Name: subject.name, "Thread URL": threadUrl(subject.key), Status: spec.pending },
			"Thread URL"
		);
	return subject.ref as string;
};

const decider = createDecider({
	config,
	store,
	renderEvidence,
	projectInput,
	resolveSubject,
	linkEntity
});

// The funnel's forward order; a stage never drags a thread backward. "Not qualified" is the
// terminal miss, off the ladder. "Approved" is terminal (nothing posts).
const LADDER: readonly string[] = config.ladder;
const rank = (s: string | null): number => (s ? LADDER.indexOf(s) : -1);

const statusOf = async (u: string): Promise<string | null> => {
	const [r] = await store.query(config.models.RedditThreads, {
		property: "Thread URL",
		url: { equals: u }
	});
	return r ? String(r.fields.Status ?? "") : null;
};

// queue(t) — make (or refresh) the backlog candidate from one listing hit, its Thread evidence
// frozen straight from the listing (title + the FULL post body — all a qualification needs). Never
// queues the owner (you don't reply to yourself). Monotonic: "To qualify" is written only when the
// thread hasn't already advanced (or terminally missed), so a re-run converges, never moves backward.
export const queue = async (
	t: Threads["threads"][number],
	subreddit: string,
	ranAt: string
): Promise<{
	url: string;
	queued: boolean;
	status: string | null;
	reason?: string;
	thread?: string;
}> => {
	const u = threadUrl(t.url);
	if (OWNER && t.author?.toLowerCase() === OWNER.toLowerCase())
		return { url: u, queued: false, status: null, reason: "owner" };
	const current = await statusOf(u);
	const advanced = current === "Not qualified" || rank(current) >= rank("To qualify");
	const row: RedditThreads = {
		Name: nameOf(subreddit, t.title),
		"Thread URL": u,
		Subreddit: subreddit,
		Author: t.author ?? undefined,
		Preview: t.body ?? undefined,
		Created: t.created,
		Score: t.score,
		Comments: t.num_comments,
		// The evidence field: the thread as the listing gave it (title + full post), rendered by
		// evidence.ts as a Reddit card. The flat columns stay for the Notion table view; this is
		// what the judge and the review app render. Link/image posts have no text — title-only card.
		Thread: stringify(
			{
				subreddit,
				url: u,
				title: t.title,
				author: t.author ?? undefined,
				created: t.created,
				score: t.score,
				num_comments: t.num_comments,
				// What KIND of post this is — and the listing already knows it, so it costs no fetch. It is
				// the field that keeps two negatives apart: 22% of stored threads have no `op_text`, and
				// without this the evidence reads the same "(no text)" whether the OP wrote nothing or the
				// post is an image with nothing to write. One is an empty post, the other is a post whose
				// content is not text at all — and only one of them is a thread anyone can answer.
				post_type: t.post_type ?? undefined,
				op_text: t.body ?? undefined
			},
			{ lineWidth: 0 }
		),
		"Scanned at": ranAt,
		...(advanced ? {} : { Status: "To qualify" })
	};
	const r = await store.upsert(config.models.RedditThreads, row, "Thread URL");
	return { url: u, queued: !advanced, status: advanced ? current : "To qualify", thread: r.url };
};

// refresh(url) — re-read ONE thread from its own page and re-freeze it, returning the stored row.
// The listing gives the post; only the page gives what was said under it, so this is where the
// comment tree comes from. A tool rather than a bare `reduck run` because it does both things a
// tool is for (README #3): it composes the fetch with the store write, and it writes the seed in
// exactly the shape `queue` froze, so the renderer and every quote offset stay in one space.
//
// It is a PRIMITIVE, not a funnel step, and what makes it reusable is what it refuses to touch: the
// evidence columns only (Thread, Score, Comments) — never Status, Tier or Name. So it is safe at
// any rung, any number of times, and the funnel's second read is only its first caller. A later one
// ("did the OP answer the reply we posted?") reads the row, calls this, and diffs the two seeds'
// `comments` — no change here.
//
// `comments` is written ALWAYS, even as `[]`: its presence is what tells a re-run the fetch already
// happened (see `hasCommentTree`). Score and the comment count are refreshed while we are here —
// they moved since the scan, and they are the two numbers the card shows.
export const refresh = async (url: string): Promise<Row> => {
	const u = threadUrl(url);
	const t = await getThread(u);
	// Partial, and that is the point: an upsert writes only the fields it is handed, so omitting
	// Name (required on a full row — it is the Notion title) is how this leaves identity alone.
	const row: Partial<RedditThreads> = {
		"Thread URL": u,
		Score: t.score,
		Comments: t.num_comments,
		Thread: stringify(
			{
				subreddit: t.subreddit,
				url: u,
				title: t.title,
				author: t.author ?? undefined,
				created: t.created,
				score: t.score,
				num_comments: t.num_comments,
				post_type: t.post_type ?? undefined,
				// Where a link/image/video post actually points — the page's answer to the question
				// `post_type` raises. For those posts the destination IS the content, so a thread that
				// reads as empty is only empty because we dropped the one field that held it.
				content_href: t.content_href ?? undefined,
				op_text: t.op_text || undefined,
				comments: t.comments.map((c) => ({
					author: c.author ?? undefined,
					body: c.body,
					score: c.score ?? undefined,
					depth: c.depth,
					// The discussion's clock. Without it the tree is a flat set of opinions: nothing says
					// whether the thread is still alive, nor whether the OP's own reply landed before or
					// after the answer it appears to concede to — which is much of why a reply reads the
					// tree at all.
					created: c.created ?? undefined
				}))
			},
			{ lineWidth: 0 }
		)
	};
	await store.upsert(config.models.RedditThreads, row, "Thread URL");
	// Read back rather than merge in memory: the next judgment reads the row, so it must read what
	// the store actually holds — the same rule `decide("reply", url)` obeys one stage later.
	return readThread(u);
};

export const tools = {
	// scan — discovery only: each watched subreddit's threads newer than `since` (the script's own
	// chronological window), queued with their evidence at "To qualify". No LLM — judging is
	// `engage`'s job, reading that status back as its worklist. Dedup across subreddits and re-runs
	// is structural — Thread URL + the monotonic guard.
	// One reduck run per subreddit — the rules a reply must obey are declared in config.ts, so
	// discovery has nothing to refresh (`rules` below derives them, as a setup step).
	scan: async (since = "48h", subreddits: readonly string[] = Object.keys(SUBREDDITS)) =>
		mapLimit([...subreddits], async (subreddit) => {
			const ranAt = new Date().toISOString();
			const { threads } = await getSubredditThreads(subreddit, since);
			const queued = (await mapLimit(threads, (t) => queue(t, subreddit, ranAt))).filter(
				(q) => q.queued
			);
			return { subreddit, seen: threads.length, queued };
		}),

	// engage — everything still owed on one thread, read off its rung: qualify it if that hasn't
	// happened, then draft the reply if it earned one. Monotonic — it no-ops at or past the draft
	// gate and on the terminal "Not qualified", so a re-run (or engagePending, or a second scan)
	// never double-judges and never double-drafts.
	//
	// Qualification is a JUDGMENT, not a Decision: it is calibrated (eval_qualify.mjs green on the
	// ground truth), so no human will ever rule on it, and a Decision born already-committed is
	// noise in the queue a human actually reads. What survives is what a later reader needs — the
	// Tier and Status columns, plus the claims as a comment ON THE THREAD PAGE, so "why was this
	// even qualified?" is answered where you are already looking. When the answer is "it shouldn't
	// have been", the fix is a line in reddit_qualified_threads.yaml and a re-run of the eval; no
	// Decision was ever involved in that loop.
	engage: async (url: string) => {
		const u = threadUrl(url);
		// ONE read of the thread row serves both the funnel guard and the judgment: the guard needs the
		// Status, the judgment needs the frozen evidence, and they are the same row.
		let row = await readThread(u);
		const status = String(row.fields.Status ?? "");
		if (status === "Not qualified" || rank(status) >= rank("Draft pending review"))
			return { url: u, skipped: true, status };
		let tier = String(row.fields.Tier ?? "");
		let screened: string | undefined;
		if (rank(status) < rank("To engage")) {
			// ONE question, asked twice as the evidence grows — not two prompts. The criteria, the
			// Output schema and the Prompt row are the same both times; all that differs is that the
			// second read can see what was said under the post. So there is nothing to keep in sync,
			// and the guard on the fetch is DATA, not a flag or a rung: a seed that already carries a
			// comment tree is read once, definitively, which is also what makes a crashed run resumable.
			let v = await decider.judge("qualify", subjectOf(u, row));
			if (config.prompts!.qualify.resolve(v.output).advances && !hasCommentTree(row)) {
				// The pre-screen's only power is to spend a browser run, or not. Most threads never get
				// here, which is the whole reason the read is split (README #9): the listing already
				// carries the post, so this fetch buys the comments and nothing else.
				screened = tierOf(v);
				row = await refresh(u);
				v = await decider.judge("qualify", subjectOf(u, row));
			}
			const move = config.prompts!.qualify.resolve(v.output);
			tier = tierOf(v);
			// The Tier lands on the THREAD row, not only inside the verdict: the thread is the entity
			// both stages resolve, so it is the one place they share data. That is how the reply sees it
			// — the reply prompt's Input schema names Tier, so it freezes into the draft's Input and
			// renders as evidence (a reviewer sees what the reply answers AND how hard a fit it was).
			// It is also just a column, so the Notion table filters and sorts by it for free.
			await Promise.all([
				store.upsert(
					config.models.RedditThreads,
					{ "Thread URL": u, Status: move.status, Tier: tier },
					"Thread URL"
				),
				store.comment(
					row.id,
					[
						screened && screened !== tier
							? `qualified ${tier} — the post alone read ${screened}; the comments changed it`
							: `qualified ${tier}${screened ? " — comments read, verdict unchanged" : " — on the post alone"}`,
						"judged by the funnel, no human ruled on this",
						...v.statements.map((s) => `${s.supporting ? "+" : "−"} ${s.claim}`)
					].join("\n")
				)
			]);
			if (!move.advances)
				return { url: u, tier, ...(screened ? { screened } : {}), status: move.status };
		}
		// By KEY, not the Subject in hand: the draft's evidence must include the Tier just written, so
		// this stage reads the row back rather than judging a copy that predates its own gate.
		const draft = await decider.decide("reply", u);
		return {
			url: u,
			tier,
			...(screened ? { screened } : {}),
			status: config.prompts!.reply.pending,
			draft: draft.open ?? draft.id
		};
	},

	// engagePending — drain `engage` over the whole backlog: BOTH unfinished rungs, "To qualify"
	// (scan's output) and "To engage" (qualified, drafting never happened — a crashed run leaves
	// threads exactly there, and a filter on the first rung alone would strand them forever).
	// Engaging a thread advances it past both, so the drain pages the backlog with no cursor.
	engagePending: () =>
		drain(
			store,
			config.models.RedditThreads,
			{
				or: [
					{ property: "Status", select: { equals: "To qualify" } },
					{ property: "Status", select: { equals: "To engage" } }
				]
			},
			(r) => tools.engage(String(r.fields["Thread URL"]))
		),

	// dump — every stored thread of one subreddit, raw: the frozen Thread seed (title + full post,
	// exactly as `queue` froze it) plus the row's current Status. A full read, not a worklist — it
	// walks the whole set via queryAll (a filter page can't prove the rest). Filtered on the
	// canonical Thread URL, never the Subreddit column: threadUrl lowercases the sub, so the key
	// matches however the scan was cased. Newest first. Reads everything, writes nothing.
	dump: async (subreddit: string) => {
		const sub = subreddit.replace(/^r\//i, "").toLowerCase();
		const rows = await queryAll(store, config.models.RedditThreads, {
			property: "Thread URL",
			url: { contains: `/r/${sub}/comments/` }
		});
		return rows
			.map((r) => ({
				url: String(r.fields["Thread URL"] ?? ""),
				...((parse(String(r.fields.Thread ?? "")) ?? {}) as object),
				status: r.fields.Status ?? null
			}))
			.sort((a, b) =>
				String((b as { created?: string }).created ?? "").localeCompare(
					String((a as { created?: string }).created ?? "")
				)
			);
	},

	// refresh — the primitive above, exposed: re-pull one thread's page and re-freeze it. Evidence
	// only, so it never disturbs where a thread sits in the funnel.
	refresh: (url: string) =>
		refresh(url).then((r) => ({
			url: threadUrl(url),
			comments: seedOf(r)?.comments?.length ?? 0
		})),

	// draft — manually (re-)draft a reply for one thread on the frozen evidence, moving it to the
	// draft gate. No dependency to carry: the qualification is a judgment, not a Decision, so there
	// is no gate for a draft to sit behind. `context` prints the frozen judgment context, writes nothing.
	draft: (url: string) => decider.decide("reply", threadUrl(url)),
	context: (url: string) => decider.context("reply", threadUrl(url)),

	// list / show — the review queue and one Decision, straight off the shared engine.
	list: () => decider.list(),
	show: (handle: string) => decider.showDecision(handle)
};
