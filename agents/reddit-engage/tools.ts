// reddit-engage tools — the funnel, the lk-engage shape (fetch and judge are separate stages;
// the store IS the queue between them — "To qualify" is the worklist, not an in-memory list):
//   scan   → each watched subreddit's NEW threads (one listing run each — the listing's `body` is
//            the post's FULL text, so discovery already carries the evidence; no per-thread fetch
//            exists in this agent), queued as Reddit Threads at "To qualify". No LLM.
//   engage → qualify (LLM, title + post), AUTO-ACCEPTED by the tool (`accept` below — the prompt
//            is calibrated; the Decision stays as the committed trace) → if it advances, a reply
//            draft (LLM, dependsOn the committed gate) lands straight in the review queue. No
//            args ⇒ drain every thread at "To qualify"; either stage re-runs safely after a crash.
//   [human gate] → ONLY the reply drafts: confirming one moves the thread to "Approved" (sending
//            is unwired); a "No" qualification terminally parks the thread at "Not qualified".
// READ-ONLY: never posts to Reddit. Monotonic + idempotent on the canonical Thread URL.

import { getSubredditInfo, getSubredditThreads, threadUrl } from "../../src/clients/reddit/index.js";
import { getStore, queryAll } from "../../src/stores/index.js";
import { createDecider } from "../../src/decide.js";
import { renderEvidence } from "./evidence.js";
import { remember, rulesOf } from "./subreddits.js";
import { projectInput } from "../../src/project.js";
import { mapLimit } from "../../src/concurrency.js";
import { drain } from "../../src/drain.js";
import { parse, stringify } from "yaml";
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
//
// One field is JOINED rather than read: the community's rules (subreddits.ts), which belong to the
// subreddit, not the thread. Joining them here — instead of storing a copy on every thread row —
// keeps one place to refresh them, and they still land in the Decision's frozen Input (so the review
// app renders them and the drafter can cite one), because that freeze is of the projected fields, not
// of the row. A prompt whose Input schema doesn't name "Subreddit rules" simply never sees them.
const resolveSubject = async (url: string): Promise<Subject> => {
	const row = await store.read(config.models.RedditThreads, "Thread URL", threadUrl(url));
	const rules = rulesOf(String(row.fields.Subreddit ?? ""));
	return {
		key: url,
		name: String(row.fields.Name ?? url),
		fields: { ...row.fields, ...(rules ? { "Subreddit rules": rules } : {}) },
		ref: row.id
	};
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
export const queue = async (
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
	//
	// One visit, both things a subreddit has to tell us: its new threads AND its own rules, fetched
	// together (they share the browser gate, so the pair costs about as long as the listing alone) and
	// the rules folded into subreddits.yaml. That is the whole maintenance of the rules a reply must
	// obey — the stage that already comes here keeps them current, and `remember` only touches the
	// file when a community actually changed them.
	scan: async (since = "48h", subreddits: readonly string[] = SUBREDDITS) =>
		mapLimit([...subreddits], async (subreddit) => {
			const ranAt = new Date().toISOString();
			const [info, { threads }] = await Promise.all([
				getSubredditInfo(subreddit),
				getSubredditThreads(subreddit, since)
			]);
			remember(info);
			const queued = (await mapLimit(threads, (t) => queue(t, subreddit, ranAt))).filter((q) => q.queued);
			return { subreddit, rules: info.rules?.length ?? 0, seen: threads.length, queued };
		}),

	// engage — the judgment chain for one thread: qualify, accept, and — when it advances — the
	// reply draft (dependsOn the committed gate, so the app shows it at once; the human gate is
	// ONLY the drafts). Qualification is calibrated (eval_qualify.mjs green on every ground-truth
	// digest), so the tool commits its own qualification instead of parking it at the human gate:
	// "Final output" ≡ Output — exactly what the review app's Confirm writes, so the Decision stays
	// as the trace and agreement derives as Accepted — the thread moves straight to
	// resolve(output).status (forward, or the terminal "Not qualified"), and a page comment answers
	// the audit question: no human reviewed this. Monotonic: no-ops once a qualification is pending
	// or beyond (and on the terminal "Not qualified"), so a re-run — or engagePending — never
	// double-drafts.
	engage: async (url: string) => {
		const u = threadUrl(url);
		const status = await statusOf(u);
		if (status === "Not qualified" || rank(status) >= rank("Qualification pending review"))
			return { url: u, skipped: true, status };
		const q = await decider.decide("qualify", u);
		const move = config.prompts!.qualify.resolve(q.output);
		const tier = String((q.output as { tier?: unknown }).tier ?? "");
		const name = String((await store.get(q.id)).fields.Name);
		// The Tier lands on the THREAD row, not just inside the qualification's Output: the thread is
		// the entity BOTH decisions resolve, so it is the one place the two can share data. That makes
		// the tier available to the reply the same way everything else is — the reply prompt's Input
		// schema names it, so it freezes into the draft's Input and renders as evidence (a reviewer
		// sees what the reply is answering AND how hard a fit it was). It is also just a column, so
		// the Notion table filters and sorts by it for free.
		await Promise.all([
			store.upsert(config.models.Decisions, { Name: name, "Final output": JSON.stringify(q.output) }, "Name"),
			store.upsert(config.models.RedditThreads, { "Thread URL": u, Status: move.status, Tier: tier }, "Thread URL"),
			store.comment(q.id, "auto-accepted by the funnel — qualification is calibrated; no human reviewed this decision")
		]);
		const draft = move.advances ? await decider.decide("reply", u, { dependsOn: [q.id] }) : null;
		return {
			url: u,
			tier: String((q.output as { tier?: unknown }).tier ?? "?"),
			status: move.status,
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

	// draft — manually (re-)draft a reply for one thread on the frozen evidence. Standalone by
	// default (no dependency, so it moves the thread to the draft gate); pass `dependsOn` to attach
	// the redraft to the qualification it belongs behind, which is what keeps a replacement draft in
	// its chain — same provenance, and the review order still sorts it at its gate's slot.
	// `context` prints the frozen judgment context, writes nothing.
	draft: (url: string, dependsOn?: string[]) =>
		decider.decide("reply", threadUrl(url), dependsOn?.length ? { dependsOn } : {}),
	context: (url: string) => decider.context("reply", threadUrl(url)),

	// list / show — the review queue and one Decision, straight off the shared engine.
	list: () => decider.list(),
	show: (handle: string) => decider.showDecision(handle)
};
