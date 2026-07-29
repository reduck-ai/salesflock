// reddit-engage tools — the funnel, the lk-engage shape (fetch and judge are separate stages;
// the store IS the queue between them — "To qualify" is the worklist, not an in-memory list):
//   scan   → each watched subreddit's NEW threads (one listing run each — the listing's `body` is
//            the post's FULL text, so discovery already carries the evidence; no per-thread fetch
//            exists in this agent), queued as Reddit Threads at "To qualify". No LLM.
//   engage → qualify (LLM, title + post) → if it scores well, a reply draft (LLM) held behind the
//            qualification via dependsOn, so the review app reveals the draft only once a human
//            approves the qualification (and archives it on "Not interesting"). No args ⇒ drain
//            every thread at "To qualify"; either stage re-runs safely after a crash.
//   [human gate] → confirming the reply draft moves it to "Approved" (sending is unwired).
// READ-ONLY: never posts to Reddit. Monotonic + idempotent on the canonical Thread URL.

import { getSubredditThreads, threadUrl } from "../../src/clients/reddit/index.js";
import { getStore } from "../../src/stores/index.js";
import { createDecider } from "../../src/decide.js";
import { renderEvidence } from "./evidence.js";
import { projectInput } from "../../src/project.js";
import { mapLimit } from "../../src/concurrency.js";
import { drain } from "../../src/drain.js";
import { stringify } from "yaml";
import config, { SUBREDDITS, OWNER } from "./config.js";
import type { Subject } from "../../src/decide.js";
import type { PromptSpec } from "../../src/stores/index.js";
import type { Threads } from "../../src/clients/reddit/index.js";
import type { RedditThreads } from "./schema/RedditThreads.js";

const store = getStore(config.destination);

// A short, single-line label from a thread's title. Slices by CODE POINT (`[...s]`), never by code
// unit, so it can't cut an emoji's surrogate pair in half.
const label = (text: string, n = 60): string => [...text.replace(/\s+/g, " ").trim()].slice(0, n).join("");

const nameOf = (subreddit: string, title: string): string => `r/${subreddit} — ${label(title)}`;

// The Reddit entity bridge (this agent's own wiring): the Reddit Thread row IS the subject — it
// carries the frozen Thread evidence projectInput reads — AND the pipeline entity the Decision
// binds to.
const resolveSubject = async (url: string): Promise<Subject> => {
	const row = await store.read(config.models.RedditThreads, "Thread URL", threadUrl(url));
	return { key: url, name: String(row.fields.Name ?? url), fields: row.fields, ref: row.id };
};
const linkEntity = async (
	subject: Subject,
	spec: PromptSpec,
	{ dependsOn }: { dependsOn?: string[] }
): Promise<string> => {
	if (!dependsOn?.length)
		await store.upsert(
			config.models.RedditThreads,
			{ Name: subject.name, "Thread URL": threadUrl(subject.key), Status: spec.pending },
			"Thread URL"
		);
	return subject.ref as string;
};

const decider = createDecider({ config, store, renderEvidence, projectInput, resolveSubject, linkEntity });

// The funnel's forward order; a stage never drags a thread backward. "Not qualified" is the
// terminal miss, off the ladder. "Approved" is terminal (nothing posts).
const LADDER: readonly string[] = config.ladder;
const rank = (s: string | null): number => (s ? LADDER.indexOf(s) : -1);

const statusOf = async (u: string): Promise<string | null> => {
	const [r] = await store.query(config.models.RedditThreads, { property: "Thread URL", url: { equals: u } });
	return r ? String(r.fields.Status ?? "") : null;
};

// queue(t) — make (or refresh) the backlog candidate from one listing hit, its Thread evidence
// frozen straight from the listing (title + the FULL post body — all a qualification needs). Never
// queues the owner (you don't reply to yourself). Monotonic: "To qualify" is written only when the
// thread hasn't already advanced (or terminally missed), so a re-run converges, never moves backward.
const queue = async (
	t: Threads["threads"][number],
	subreddit: string,
	ranAt: string
): Promise<{ url: string; queued: boolean; status: string | null; reason?: string; thread?: string }> => {
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

export const tools = {
	// scan — discovery only: each watched subreddit's threads newer than `since` (the script's own
	// chronological window), queued with their evidence at "To qualify". No LLM — judging is
	// `engage`'s job, reading that status back as its worklist. Dedup across subreddits and re-runs
	// is structural — Thread URL + the monotonic guard.
	scan: async (since = "48h", subreddits: readonly string[] = SUBREDDITS) =>
		mapLimit([...subreddits], async (subreddit) => {
			const ranAt = new Date().toISOString();
			const { threads } = await getSubredditThreads(subreddit, since);
			const queued = (await mapLimit(threads, (t) => queue(t, subreddit, ranAt))).filter((q) => q.queued);
			return { subreddit, seen: threads.length, queued };
		}),

	// engage — the judgment chain for one thread: qualify, and — the moment it scores well — the
	// reply draft, bound to the qualification via `dependsOn` so the review app keeps it hidden
	// until a human approves (and drops it for good on "Not interesting"). Monotonic: no-ops once a
	// qualification is pending or beyond (and on the terminal "Not qualified"), so a re-run — or
	// engagePending — never double-drafts.
	engage: async (url: string) => {
		const u = threadUrl(url);
		const status = await statusOf(u);
		if (status === "Not qualified" || rank(status) >= rank("Qualification pending review"))
			return { url: u, skipped: true, status };
		const q = await decider.decide("qualify", u);
		const good = config.prompts!.qualify.resolve(q.output).advances;
		const draft = good ? await decider.decide("reply", u, { dependsOn: [q.id] }) : null;
		return {
			url: u,
			tier: String((q.output as { tier?: unknown }).tier ?? "?"),
			qualify: q.open ?? q.id,
			...(draft ? { draft: draft.open ?? draft.id } : {})
		};
	},

	// engagePending — drain `engage` over every thread at "To qualify" (scan's output). Judging a
	// thread advances it out of the filter, so the drain pages the whole backlog with no cursor.
	engagePending: () =>
		drain(store, config.models.RedditThreads, { property: "Status", select: { equals: "To qualify" } }, (r) =>
			tools.engage(String(r.fields["Thread URL"]))
		),

	// draft — manually (re-)draft a reply for one thread as a STANDALONE Decision (no qualification
	// dependency), on the frozen evidence. `context` prints the frozen judgment context, writes nothing.
	draft: (url: string) => decider.decide("reply", threadUrl(url)),
	context: (url: string) => decider.context("reply", threadUrl(url)),

	// list / show — the review queue and one Decision, straight off the shared engine.
	list: () => decider.list(),
	show: (handle: string) => decider.showDecision(handle)
};
