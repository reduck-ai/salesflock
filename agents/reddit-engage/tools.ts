// reddit-engage tools — the funnel. Fetch and judge are separate stages and the STORE is the queue
// between them, but what marks a thread's place is now DATA, not a rung:
// THE TOP OF THE FUNNEL IS `SUBREDDITS` (config.ts), and one function says so for both stages that
// spend anything: `watched` resolves the communities `scan` discovers and the ones the drain judges,
// throwing on a name that declares no rules. So removing an entry stops both, adding one starts both,
// and `--subreddit` narrows within it and can never widen past it. READING is deliberately not
// bounded (`threads get`/`dump`): the corpus includes communities we have stopped watching, which is
// what a ground-truth dump is cut from.
//
//   scan   → each watched subreddit's NEW threads (one listing run each — the listing's `body` is
//            the post's FULL text, so discovery already carries everything a qualification needs; no
//            per-thread fetch exists in this agent), upserted as Reddit Threads. The seed only, no
//            funnel state, no LLM — so a re-scan of a thread deep in the funnel cannot disturb it.
//   engage → qualify (LLM) as a JUDGMENT, not a Decision — the prompt is calibrated against
//            reddit_qualified_threads.yaml, so nobody rules on it and minting a Decision would only
//            be noise in the human's queue. Its whole record is the thread's Tier plus a comment on
//            the thread page. It reads TWICE on growing evidence, one prompt both times: the post
//            alone (cheap, drops most threads with no fetch), then — only for a survivor — the
//            thread's own page via `refresh`, because an OP volunteers under their post what the
//            post never says ("I'm a broke student"). → if it still advances, a reply draft (the one
//            Decision) opens a Reddit Backlog row at "Pending approval". The thread filters name WHICH
//            threads; no args ⇒ everything owed. `pending` describes that same set without draining it.
//   [human gate] → confirming a draft POSTS it (config.ts `reply.act`) and lands the outreach at
//            "Waiting for OP". Approving and posting are one act, so there is no state between them.
//
// AN OUTREACH IS A PERSON, NOT A THREAD. The Backlog keys on the canonical account URL
// (`userUrl`), so a human who posts twice is one conversation — the Thread relation is 1:N. Before
// that, identity was the thread and a cross-poster got two replies eighteen minutes apart, which is
// the shape a mod reads as spam. It catches repeat posters too, not just cross-posts: of 53
// qualified threads, 4 authors had two each and only two of those pairs were cross-posts.
//
// Two writes touch an outreach and only ONE of them can move it — that split is the whole guarantee
// that a newly scanned thread from someone we already track disturbs nothing:
//   linkEntity  opens/re-opens the conversation, writes Status. Runs only when we are drafting.
//   attach      writes the THREAD's own relation. No Backlog column, so nothing to guard.
// `scan` cannot reach either: `queue` writes only the columns it is handed, and Backlog is not one.
//
// WHAT IS OWED IS DERIVED, never stored — the two facts that place a thread are both data a stage
// already had to write, so there is no third thing to keep in sync and nothing to drag backward:
//   Tier empty                      → not judged yet          (qualify owes it)
//   Tier T1/T2 + no Backlog row     → judged, never drafted   (draft owes it — a crashed run resumes here)
//   Tier "No"                       → terminal, judged out
// The second line is unchanged by the re-key, which is why it stayed small: the relation was
// already the marker, and all that widened is what it may point at (one outreach ← many threads).
// The Tier is persisted deliberately: flash is not run-stable on borderline threads, so re-judging
// after a crash could flip a T2 to "No" and freeze that false negative forever.
//
// Monotonic + idempotent on the canonical Thread URL, which keys BOTH tables.

import { getSubredditThreadsAll, getThread, sinceIso, subOf, threadUrl, userUrl } from "../../src/clients/reddit/index.js";
import { getStore, queryAll } from "../../src/stores/index.js";
import { createDecider } from "../../src/decide.js";
import { renderEvidence } from "./evidence.js";
import { projectInput } from "../../src/project.js";
import { mapLimit } from "../../src/concurrency.js";
import { renderError } from "../../src/errors.js";
import { log } from "../../src/log.js";
import { drain } from "../../src/drain.js";
import { parse, stringify } from "yaml";
import config, { TARGETS, SUBREDDITS, OWNER, subKey } from "./config.js";
import type { Subject, Verdict } from "../../src/decide.js";
import type { PromptSpec, Row } from "../../src/stores/index.js";
import type { Threads } from "../../src/clients/reddit/index.js";
import type { RedditThreads } from "./schema/RedditThreads.js";
import type { RedditBacklog } from "./schema/RedditBacklog.js";

const store = getStore(config.destination);

// A short, single-line label from a thread's title. Slices by CODE POINT (`[...s]`), never by code
// unit, so it can't cut an emoji's surrogate pair in half.
const label = (text: string, n = 60): string =>
	[...text.replace(/\s+/g, " ").trim()].slice(0, n).join("");

const nameOf = (subreddit: string, title: string): string => `r/${subreddit} — ${label(title)}`;

// The person behind a thread — the Backlog's identity key, read off the thread's own Author column.
// That column is single-writer (only `queue` writes it, from the listing; `refresh` deliberately
// omits it), so its spelling is Reddit's own and stays consistent — and `userUrl` lowercases
// regardless, so no casing could fork an outreach even if it did drift.
//
// Loud when absent, because an outreach with no person is the one thing this table can no longer
// express. It is a guard rather than a funnel gate: 0 of the 53 qualified threads lack an author
// (11 of 4037 overall), so this fires on a thread nobody could reply to anyway.
const authorOf = (fields: Record<string, string | number | boolean>, url: string): string => {
	if (!fields.Author) throw new Error(`thread ${url} has no Author — an outreach needs a person`);
	return String(fields.Author);
};

// The Reddit entity bridge (this agent's own wiring), and the two halves are two tables: the Reddit
// THREAD row is the subject — it carries the seed projectInput reads — while the Reddit
// BACKLOG row is the pipeline entity the Decision binds to and the review app moves. A thread we
// never engage has no Backlog row, which is exactly why the two are apart.
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
	// The community off the canonical URL, never the Subreddit column — the one source `subOf` and
	// both filters already use. It matters most here: this join decides which rules a reply must obey,
	// so a spelling the column happens to carry must not be able to change what we are allowed to say.
	const rules = SUBREDDITS[subOf(url)];
	return {
		key: url,
		name: String(row.fields.Name ?? url),
		fields: { ...row.fields, ...(rules ? { "Subreddit rules": rules } : {}) },
		ref: row.id
	};
};
const readThread = (url: string): Promise<Row> =>
	store.read(config.models.RedditThreads, "Thread URL", threadUrl(url));

// The ONE write into each table, and the one place the identity key is minted.
//
// The key used to be a FIELD every caller supplied, having remembered to canonicalize it first —
// four call sites, four chances to forget. Nothing would catch a slip: Notion keys a url by string
// equality, so a non-canonical spelling does not error, does not overwrite, and does not warn. It
// CREATES A SECOND PAGE, which every filter in this file (all of them canonical) is then blind to —
// unreachable by the drain and by the Tier guard, yet still counted in every dump. A fork like that
// is silent on the way in and permanent once made, which is what makes it worth designing out
// rather than watching for. (Checked at the time of writing: 3010 stored rows, 0 non-canonical.)
//
// So the url is a positional ARGUMENT and the field map's type forbids the key. A caller cannot
// supply it, therefore cannot mis-spell it; `threadUrl` is idempotent, so minting here costs a
// re-normalization and nothing else. Convention became construction — the same move `threadUrl`
// itself makes by throwing on a non-thread string rather than trusting the caller to check.
const writeThread = (url: string, fields: Omit<Partial<RedditThreads>, "Thread URL">) =>
	store.upsert(config.models.RedditThreads, { ...fields, "Thread URL": threadUrl(url) }, "Thread URL");

// The outreach is keyed on the PERSON, not the thread — the same construction, one entity up. A
// human who posts twice is one human to talk to, so the row a re-run must converge on is theirs.
const writeBacklog = (person: string, fields: Omit<Partial<RedditBacklog>, "Person">) =>
	store.upsert(config.models.RedditBacklog, { ...fields, Person: userUrl(person) }, "Person");

// attach(thread, outreach) — join a thread to the conversation it belongs to, and the ONE write in
// this file that touches an outreach without being able to move it. It writes the THREAD's own
// `Backlog` relation; Notion syncs the pair (`Backlog` ↔ `Thread`, dual_property), so the person's
// list grows without a single column of their row being written.
//
// That is the whole reason it exists as its own call rather than a field on the upsert above: a
// second thread from someone we already track must not disturb where that conversation stands, and
// the strongest form of that guarantee is a write with no state to guard — not a read-before-write,
// not a ladder check. There is nothing here to drag backward because nothing about the person is
// said. (It is also the only way round that works: the store flattens relations away on read, so
// the person's existing `Thread` list cannot be read back to append to it — writing that side would
// clobber every sibling already attached.)
//
// It doubles as the funnel's marker, which is why no new column was needed: `NO_OUTREACH` below
// reads exactly this relation, so attaching a thread both joins it to the conversation and retires
// it from the worklist, in one write.
const attach = (url: string, outreach: string): Promise<unknown> =>
	writeThread(url, { Backlog: [outreach] });

// The Thread seed, parsed. null when the field is absent or not the shape `queue` writes —
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
//
// Stated on the SEED, because two callers ask it and only one of them holds a Row: the funnel's
// second read (`engage`, which has the row) and `scan`, which has already parsed the seeds of a
// whole subreddit. One predicate, so the two can never disagree about what "we looked" means.
export const fetchedComments = (seed: Seed | null): boolean => Array.isArray(seed?.comments);
const hasCommentTree = (row: Row): boolean => fetchedComments(seedOf(row));

const tierOf = (v: Verdict): string => String((v.output as { tier?: unknown }).tier ?? "");
const resolveSubject = async (url: string): Promise<Subject> =>
	subjectOf(url, await readThread(url));

// linkEntity — open (or re-open) the OUTREACH this decision advances, and hand back its row id for
// the Decision to bind to. Keyed on the PERSON, so the row a re-run converges on is the human's,
// not the thread's — one conversation per person, whatever they posted.
//
// It is the ONLY write in this file that can move an outreach, and it runs on exactly one path:
// we are drafting a reply. Everything else that touches a conversation goes through `attach`, which
// cannot express a move. That split is what makes "a newly scanned thread from someone we already
// track must not disturb them" true by construction rather than by a guard someone remembered.
//
// `Thread URL` is written as a plain COLUMN and it means one thing: the thread we chose to answer.
// (`reply.act` reads it to know where to post, and `Comment URL` beside it to know we already have —
// both scalars on the person's row, which is why re-keying cost the act nothing.) The `Thread`
// RELATION is deliberately not written here: it is the person's whole list, the store flattens
// relations away on read, so writing it would clobber every sibling. `attach` owns that side.
//
// This is also where the cycle closes: a follow-up drafted after the OP answers upserts the SAME
// row back to "Pending approval". Deliberately unguarded — the ladder governs the review app, whose
// risk is a stale confirm regressing a row; here there is exactly one open Decision at a time, so
// the write is the only writer and the newest draft is by definition where the outreach stands.
const linkEntity = async (
	subject: Subject,
	spec: PromptSpec,
	{ dependsOn }: { dependsOn?: string[] }
): Promise<string> => {
	// `Subject.ref` is optional on the shared type (not every agent's subject IS a store row), but
	// here it is the Thread this outreach is about — the relation that lets each be reached from the
	// other. Absent, the old inline write serialized `relation: [{ id: undefined }]`: an outreach
	// orphaned from its thread, silently. Loud instead — `subjectOf` always sets it, so this fires
	// only if that stops being true.
	if (!subject.ref)
		throw new Error(`no thread row behind ${subject.key} — cannot open an outreach with no Thread`);
	const author = authorOf(subject.fields, subject.key);
	const ref = await writeBacklog(author, {
		// Who first, then what we answered: the row IS a person now, and a list of outreaches reads as
		// the people we are talking to rather than as a second copy of the thread index.
		Name: `u/${author} — ${subject.name}`,
		"Thread URL": threadUrl(subject.key),
		// A held dependent leaves Status alone — its gate has not been ruled on yet.
		// `spec.pending` is a free string on the shared PromptSpec (core cannot know one agent's
		// column enum); the generated schema is where that enum actually lives. Same seam as the
		// Tier write below — config.ts declares the literal, this asserts it against the column.
		...(dependsOn?.length ? {} : { Status: spec.pending as RedditBacklog["Status"] })
	});
	// The thread joins the conversation from its OWN side, exactly as a sibling does — one idiom, so
	// the row this decision is about is attached the same way as the ones it is not.
	await attach(subject.key, ref.id);
	return ref.id;
};

// Exported for ONE consumer beyond this file: `sflock eval` (src/eval.ts), which re-judges a stored
// thread under candidate instructions. It goes through the decider rather than rebuilding the
// context so the eval is faithful BY CONSTRUCTION — `judgmentContext` resolves the subject, joins
// the subreddit rules, projects the Input, renders the evidence and builds the few-shot block with
// the case under test excluded. An eval that re-derives any of that is measuring a copy of the code
// that runs, not the code that runs. Read-only: only `decide` writes, and the eval never calls it.
// preScreen(input) — the evidence the FIRST of `engage`'s two reads saw: the same projected Input
// with the comment tree taken out. The eval's seam (src/eval.ts), and the only agent-specific thing
// a label-graded eval needs, because core cannot know which field a later stage adds.
//
// It exists because the pre-screen holds a veto nothing else can catch: a thread it drops is never
// fetched, so the deciding read never happens and the miss leaves no trace. The verdict may
// legitimately differ between the two reads — that is why the page is fetched at all — but a
// pre-screen 'No' on a thread the truth engages is eliminating on the ABSENCE of evidence, frozen
// forever by a monotonic funnel. null when there is nothing to strip: the two reads are then the
// same read, so the eval spends nothing.
export const preScreen = (input: Record<string, string>): Record<string, string> | null => {
	const seed = parse(input.Thread ?? "") as Seed | null;
	if (!fetchedComments(seed)) return null;
	const { comments: _comments, ...post } = seed as Seed;
	return { ...input, Thread: stringify(post, { lineWidth: 0 }) };
};

export const decider = createDecider({
	id: "reddit-engage",
	config,
	store,
	renderEvidence,
	projectInput,
	resolveSubject,
	linkEntity
});

// WHICH threads — the one filter vocabulary, spoken by every command that names a set of them:
// the two projections that READ one (`threads get`, `threads dump`) and the one that WORKS on one
// (`engage`, which narrows it further to what still owes work). So reading a set, saving it and
// judging it can never disagree about which threads were meant.
//
// It selects THREADS, and a thread's own facts are all it offers: which one, which community, how it
// was judged, when it was posted. Neither what is still OWED on it nor where an OUTREACH stands is
// among them — the first is the drain's business (`pendingFilterOf` below, which is these clauses
// plus its own), the second the Backlog's, and both would be asking this table about something it
// does not carry.
// How you name a SET, in the words both tables share — because both CARRY the canonical Thread URL,
// so either can be asked about the same threads. (They no longer both key on it: an outreach keys
// on its person and carries the thread it answers. The words still land on both, which is what
// matters here.) Each vocabulary below is this plus its own table's columns, which is exactly the
// real difference between them.
export interface Ident {
	url?: string[];
	subreddit?: string[];
	limit?: number;
}
export interface Select extends Ident {
	tier?: string;
	since?: string;
}

// urlClause / subClause — the two ways to name threads by identity, shared by both vocabularies
// because both tables carry the same canonical Thread URL. Subreddits key on that URL, never on a
// Subreddit column: the URL was lowercased when it was minted, so no spelling of a community can
// fork it — the same choice `subOf` makes. An exact URL goes through `threadUrl`, so any shape
// Reddit renders finds the row and a non-thread string fails loud instead of matching nothing.
// watched(names) — WHICH communities this funnel may touch: the names given, else the whole
// watchlist. The top of the funnel is SUBREDDITS and nothing else, so this NARROWS and can never
// widen — a name it doesn't declare throws rather than resolving, the same way `threadUrl` refuses a
// non-thread string instead of minting a key that would fork a row forever.
//
// It is one function because it is one decision, and both stages now make it here: `scan` (don't
// discover what we don't watch) and the drain (don't judge it). Being loud is the load-bearing half —
// an undeclared community has no rules entry, so a thread there reaches the drafter with no
// "Subreddit rules" field at all and is judged against nothing, two stages from where anyone would
// notice. (Measured: three communities sat in the store that way for weeks.) Refusing here is what
// makes `tools.watchlist`'s old `rules: null` case unreachable rather than merely reported.
const watched = (names?: readonly string[]): string[] => {
	const keys = (names?.length ? names : Object.keys(SUBREDDITS)).map(subKey);
	const undeclared = keys.filter((k) => !(k in SUBREDDITS));
	if (undeclared.length)
		throw new Error(
			`no rules declared for r/${undeclared.join(", r/")} — add them to SUBREDDITS in config.ts ` +
				`(reduck run --script reduck/reddit.com/get_subreddit_info subreddit=<name>)`
		);
	return keys;
};

const anyOf = (clauses: object[]): object[] =>
	clauses.length ? [clauses.length === 1 ? clauses[0] : { or: clauses }] : [];
// The identity half of both vocabularies, in one place: "every row of this table" plus whichever of
// the two ways to narrow it were asked for. The base clause is the identity's own presence, which is
// exactly what "every thread" means here; each clause is a leaf or one `or` of leaves, so a filter
// built on it stays inside Notion's two-level nesting cap however many options are combined.
const identityClauses = ({ url, subreddit }: Ident): object[] => [
	{ property: "Thread URL", url: { is_not_empty: true } },
	...anyOf((url ?? []).map((u) => ({ property: "Thread URL", url: { equals: threadUrl(u) } }))),
	...anyOf(
		(subreddit ?? []).map((s) => ({
			property: "Thread URL",
			url: { contains: `/r/${subKey(s)}/comments/` }
		}))
	)
];

// newest(rows, key, limit) — the tail both readers share: newest first, then trim. `limit` trims the
// ANSWER, never the work (every read walks all pages — one page cannot prove the rest), so it is how
// many rows you want to look at, not a way to pay less.
const newest = <T>(rows: T[], key: (t: T) => string, limit?: number): T[] => {
	const all = [...rows].sort((a, b) => key(b).localeCompare(key(a)));
	return limit ? all.slice(0, limit) : all;
};

// The Tier leaves, written once: `tierIs` answers both the vocabulary's own --tier and the OWED
// clause below, so "judged T1" cannot come to mean two things depending on who is asking.
const UNJUDGED = { property: "Tier", select: { is_empty: true } };
const tierIs = (t: string) => ({ property: "Tier", select: { equals: t } });

// threadClauses(opts) — the thread vocabulary compiled to store clauses: the shared identity clauses
// plus this table's own two columns, each ANDed on, so no option ever widens the set. CLAUSES rather
// than a finished filter, because the same words answer two questions — the corpus, and what is still
// owed on it — and sharing the list is what stops the two drifting about what a word selects.
// `limit` is deliberately not among them: it shapes a READING (`newest` applies it), so it is not a
// fact about the set, and a filter that honoured it would silently hide work from the drain.
const threadClauses = (opts: Select): object[] => [
	...identityClauses(opts),
	...(opts.tier ? [tierIs(opts.tier)] : []),
	...(opts.since ? [{ property: "Created", date: { on_or_after: sinceIso(opts.since) } }] : [])
];

// The CORPUS — every thread the words name.
const filterOf = (opts: Select): object => ({ and: threadClauses(opts) });

// WHAT IS OWED — the drain's worklist, and it is pure DATA about the thread rather than a rung
// someone remembered to write: the Tier is what qualification produced, the Backlog relation is what
// drafting produced. That is what makes it self-healing — a run that dies between the two leaves the
// thread in exactly the state its own data describes, and the next pass picks it up with nothing to
// reconcile.
//
// It reads as one sentence: not judged out, and no outreach yet. The second half is why the stages
// need no separate rules — a thread that HAS an outreach owes nothing, because whatever work it was
// due already produced a draft and a human is holding it.
//
// ONE filter, and it is still the DRAIN's: `pending` below only DESCRIBES it. That is exactly what
// makes a dry run trustworthy — the count and the act compile the same words through this same
// function, so there is no second definition of "owed" to fall out of step. It stays off the thread
// vocabulary all the same, because what is owed is not a fact about a thread: `threads` is the
// corpus, and a person's worklist is the Decisions table (`sflock decisions`) or the Backlog at
// "Pending approval".
//
// Flat by necessity: Notion caps a filter at TWO levels of nesting, and an earlier shape
// (`{or:[…,{and:[{or:[…]},…]}]}`) was three deep, so the drain over everything owed 400'd on every
// run — measured against the live table. `and → or → leaf` is two, and every clause here is a leaf
// or one `or` of leaves, so no combination of options can deepen it.
const OWED = { or: [UNJUDGED, tierIs("T1"), tierIs("T2")] };
const NO_OUTREACH = { property: "Backlog", relation: { is_empty: true } };

// outreachFor(author) — the conversation we already have with this person, or null. Through
// `query`, not `queryPage`: this is the read the draft step reasons about ABSENCE on ("we have
// never spoken to them, so draft"), and `query` refuses a truncated result rather than hand back a
// partial set — the one primitive that makes a negative provable here. One person, one row, so
// there is nothing to truncate anyway; using the strict reader is how that stays true if it ever
// stops being.
const outreachFor = async (author: string): Promise<Row | null> => {
	const rows = await store.query(config.models.RedditBacklog, {
		property: "Person",
		url: { equals: userUrl(author) }
	});
	return rows[0] ?? null;
};

// siblingsOf(author) — every thread of theirs worth answering, judged and not judged out. The set
// `bestOf` ranks, and the set the winner attaches. Deliberately NOT narrowed to threads that still
// owe work: the ranking has to be stable while a run is draining, and a set that shrank as its
// members were attached would let two workers crown two different winners.
const siblingsOf = (author: string): Promise<Row[]> =>
	queryAll(store, config.models.RedditThreads, {
		and: [
			{ property: "Author", rich_text: { equals: author } },
			{ or: [tierIs("T1"), tierIs("T2")] }
		]
	});

// bestOf(threads) — which ONE of a person's qualified threads we answer. A PURE function of rows
// the store already holds, and that purity is the whole design: every sibling drained concurrently
// computes the same winner independently, so exactly one drafts. The race is removed rather than
// guarded — no lock, no claim row, no in-process map to keep in step with the store.
//
// Purity therefore has a hard requirement: total order, no ties. T1 before T2 (fit first — it is
// the judgment the funnel spent a model on), then score (where the audience actually is: measured,
// one author's cross-post drew 13 comments in one sub and 1 in the other), then newest, then the
// canonical URL — the last is arbitrary but TOTAL, which is what a tie-break is for. Sorting on
// anything mutable-by-rescan alone (a score that moves between two workers' reads) would let them
// disagree, so the URL underneath makes the order deterministic whatever else drifts.
const RANK: Record<string, number> = { T1: 0, T2: 1 };
const bestOf = (threads: Row[]): Row =>
	[...threads].sort((a, b) => {
		const url = (r: Row) => String(r.fields["Thread URL"] ?? "");
		const num = (r: Row, k: string) => Number(r.fields[k] ?? 0);
		return (
			(RANK[String(a.fields.Tier)] ?? 9) - (RANK[String(b.fields.Tier)] ?? 9) ||
			num(b, "Score") - num(a, "Score") ||
			String(b.fields.Created ?? "").localeCompare(String(a.fields.Created ?? "")) ||
			url(a).localeCompare(url(b))
		);
	})[0];
// …and the third clause is the WATCHLIST, which is why this is the only place it goes: the top of the
// funnel is SUBREDDITS, so work is bounded by the declaration while READING stays unbounded (the
// corpus includes communities we have stopped watching — that is what a ground-truth dump is cut
// from). Exactly the line `--limit` already draws: a property of a reading is not a fact about the set.
//
// It rides in as `opts.subreddit`, so the filter logic is untouched — every clause still narrows, and
// `identityClauses` compiles this list the same way it compiles an explicit `--subreddit`. Which is
// also why the flag keeps working and can only narrow: a name outside the watchlist never reaches a
// clause, because `watched` throws first.
const pendingFilterOf = (opts: Select = {}): object => ({
	and: [...threadClauses({ ...opts, subreddit: watched(opts.subreddit) }), OWED, NO_OUTREACH]
});

// What an owed thread will COST, which is why the tally splits this way rather than counting rows:
// an UNJUDGED thread buys a qualify call, and a second one plus a browser fetch if it survives the
// pre-screen; a T1/T2 with no outreach was judged long ago and owes only the draft. One shape, used
// at both scopes — the whole queue and each community — so the parts and the total always add up.
const tally = (rows: Row[]) => ({
	total: rows.length,
	unjudged: rows.filter((r) => !r.fields.Tier).length,
	T1: rows.filter((r) => r.fields.Tier === "T1").length,
	T2: rows.filter((r) => r.fields.Tier === "T2").length
});

// WHICH outreaches — the Backlog's OWN vocabulary, and it is separate for the reason the tables are:
// an outreach's facts are where the conversation stands and what we posted, none of which a thread
// has. Only the identity flags are shared (both tables key on the canonical Thread URL, which is
// what lets you ask either one about the same thread). `--since` here reads `Posted at`, not
// `Created`: a different table keeps a different clock, and fusing them would silently answer a
// question nobody asked.
export interface BacklogSelect extends Ident {
	person?: string[];
	status?: string;
	since?: string;
}
const backlogFilterOf = (opts: BacklogSelect): object => ({
	and: [
		...identityClauses(opts),
		// The table's own identity, and the only word that selects an outreach BY WHAT IT IS. Any
		// spelling of an account resolves through `userUrl`, exactly as `--url` resolves through
		// `threadUrl` — so "u/SrvLdr", "srvldr" and the full profile URL all find the one row.
		...anyOf((opts.person ?? []).map((p) => ({ property: "Person", url: { equals: userUrl(p) } }))),
		...(opts.status ? [{ property: "Status", select: { equals: opts.status } }] : []),
		...(opts.since ? [{ property: "Posted at", date: { on_or_after: sinceIso(opts.since) } }] : [])
	]
});

// select(opts) — the core engine both thread projections read: the matching rows with their seeds
// parsed once, newest first, then `--limit`. Ordered on the seed's own `created` rather than the
// column, so the order is the thread's, whatever a re-scan wrote.
const select = async (opts: Select): Promise<{ row: Row; seed: Seed | null }[]> =>
	newest(
		(await queryAll(store, config.models.RedditThreads, filterOf(opts))).map((row) => ({
			row,
			seed: seedOf(row)
		})),
		({ seed }) => String(seed?.created ?? ""),
		opts.limit
	);

// queue(t) — record one listing hit, its seed written straight from the listing (title + the FULL
// post body — all a qualification needs). Never records the owner (you don't reply to yourself).
//
// A PURE UPSERT: it writes what Reddit says and nothing about where the thread stands, so it cannot
// move one — forward or backward — however many times it runs. That is not a guard, it is the
// absence of anything to guard. (It used to write a rung, which needed a read of the current one to
// avoid regressing it; the read was a round-trip per scanned thread, and the guard leaked anyway on
// any status outside the ladder.) Score and comment count are refreshed while we are here: they
// moved since the last scan, and they are the two numbers the card shows.
//
// `fetched` is the ONE thing it must not overwrite, and it is the exception that proves the upsert
// is pure: the listing carries no comments, so writing the seed over a thread whose PAGE was already
// read erases the tree `refresh` paid a browser run for — and `hasCommentTree` then reports "we
// never looked" about a thread we did look at, which is exactly the two negatives fusing. Measured:
// three threads decided on 2026-08-01 were re-scanned at 04:41 the next morning and lost the comment
// evidence their verdicts rest on. So the caller hands in which URLs already hold a tree and the
// seed write is skipped for those; every other column still refreshes, because those the listing
// genuinely knows better. The lookup is one store query per SUBREDDIT (see `scan`), never the
// per-thread round-trip this function was written to avoid.
export const queue = async (
	t: Threads["threads"][number],
	subreddit: string,
	ranAt: string,
	fetched: ReadonlySet<string> = new Set()
): Promise<{ url: string; queued: boolean; reason?: string; thread?: string }> => {
	const u = threadUrl(t.url);
	if (OWNER && t.author?.toLowerCase() === OWNER.toLowerCase())
		return { url: u, queued: false, reason: "owner" };
	const row: Omit<RedditThreads, "Thread URL"> = {
		Name: nameOf(subreddit, t.title),
		Subreddit: subreddit,
		Author: t.author ?? undefined,
		// No `Preview`: it was the post body a second time, written here and nowhere else — so a
		// `refresh` moved the seed and left the copy behind, and nothing ever read it back (neither
		// prompt's Input schema names it). One writer, no reader, guaranteed to drift.
		Created: t.created,
		Score: t.score,
		Comments: t.num_comments,
		// The SEED: the thread as the listing gave it (title + full post), and the field a judgment
		// projects its Input from — evidence.ts then renders that Input as a Reddit card. It is not
		// itself evidence: evidence is the snapshot a Decision freezes, and this is the live state the
		// snapshot is taken OF. The flat columns stay for the Notion table view. Link/image posts have
		// no text — title-only card.
		//
		// Omitted entirely (not written as undefined) for a thread whose page has been read: an upsert
		// writes only the fields it is handed, so leaving it out is how a re-scan leaves the richer seed
		// exactly as `refresh` wrote it.
		...(fetched.has(u) ? {} : { Thread: stringify(
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
		) }),
		"Scanned at": ranAt
	};
	const r = await writeThread(u, row);
	return { url: u, queued: r.created, thread: r.url };
};

// refresh(row) — re-read ONE thread from its own page and re-freeze it, returning the stored row.
// The listing gives the post; only the page gives what was said under it, so this is where the
// comment tree comes from. A tool rather than a bare `reduck run` because it does both things a
// tool is for (README #3): it composes the fetch with the store write, and it writes the seed in
// exactly the shape `queue` froze, so the renderer and every quote offset stay in one space.
//
// It is a PRIMITIVE, not a funnel step, and what makes it reusable is what it refuses to touch: the
// thread's own state, three columns of it (Thread, Score, Comments) — never Tier, never Name, and
// nothing on the Backlog. So it is safe wherever a thread stands, any number of times, and the
// funnel's second read is only its first caller. A later one ("did the OP answer the reply we
// posted?") reads the row, calls this, and diffs the two seeds' `comments` — no change here.
//
// It does not touch EVIDENCE, and cannot: evidence is what a Decision froze — its own copy of the
// Input, rendered at read time — so it is a snapshot of this seed at the instant of a judgment, not
// a view of it. Re-reading Reddit moves the live state that the NEXT judgment will project from, and
// reaches nothing already judged. (Which is also why every committed quote's offsets stay valid.)
//
// `comments` is written ALWAYS, even as `[]`: its presence is what tells a re-run the fetch already
// happened (see `hasCommentTree`). Score and the comment count are refreshed while we are here —
// they moved since the scan, and they are the two numbers the card shows.
//
// It takes the ROW, not a URL, and writes BY ID — the one difference between this and every other
// write in this file, and the reason is that this is the only write that lands SECONDS after the
// row was created. An upsert finds its page through a query, a query is served by an index, and the
// index lags a fresh write: the lookup misses, the upsert creates, and the thread now has a second
// page carrying only the three columns written here — no Name, no Author, no Subreddit. That is the
// silent fork the header warns about, and it happened (measured: two threads scanned at 06:24 forked
// on refresh minutes later, and the funnel then failed on the sparse twin with "has no Author").
// A `patch` addresses the page we are already holding, so there is nothing to look up and nothing to
// fork. `rdt refresh` reads the row first — by then the row is not new, and a thread we have never
// scanned is refused rather than half-created.
export const refresh = async (row: Row): Promise<Row> => {
	const u = threadUrl(String(row.fields["Thread URL"]));
	// TARGETS.thread — the cloud browser through residential egress: a public page read as nobody,
	// so no account of ours is exposed and no paired device has to be alive for it.
	const t = await getThread(u, TARGETS.thread);
	// Partial, and that is the point: a patch writes only the fields it is handed, so omitting Name
	// (required on a full row — it is the Notion title) is how this leaves identity alone.
	const fields: Omit<Partial<RedditThreads>, "Thread URL"> = {
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
	// Read back rather than merge in memory: the next judgment reads the row, so it must read what the
	// store actually holds — the same rule `decide("reply", url)` obeys one stage later. By id, like
	// the write above, for the same reason.
	await store.patch(config.models.RedditThreads, row.id, fields);
	return store.get(row.id);
};

export const tools = {
	// watchlist — WHICH communities a scan would touch, and whether we know what they allow. It
	// resolves the same argument `scan` does (the names given, else every key of SUBREDDITS), so it
	// cannot describe a different set than the run — the same reason `pending` shares the drain's
	// filter. Pure config: no browser, no store, no write.
	//
	// `rules: 0` is a community that publishes none and SAYS SO in words, which the drafter reads —
	// the only remaining case, because an UNDECLARED name no longer resolves at all: `watched` throws,
	// here and in the drain and in the scan. That is the difference between reporting a hole and not
	// having one, and it is why this no longer answers `null`.
	watchlist: (subreddits?: readonly string[]) =>
		watched(subreddits).map((s) => ({
			subreddit: s,
			rules: SUBREDDITS[s].match(/^- /gm)?.length ?? 0
		})),

	// scan — discovery only: each watched subreddit's threads newer than `since` (the script's own
	// chronological window), recorded with their evidence. No funnel state and no LLM — judging is
	// `engage`'s job, and it reads what is owed off the Tier rather than off anything written here.
	// Dedup across subreddits and re-runs is structural: one canonical Thread URL, one row, and a
	// write that says nothing about progress cannot undo any.
	// ONE reduck request for the whole watchlist — every community's listing in a single call, each on
	// its own browser (src/clients/reddit `getSubredditThreadsAll`). Discovery is the one stage that
	// asks the same question of several communities at once, so it asks once; and because each entry
	// answers for itself, a community that fails (private, banned, a bad window) reports its error
	// beside the others' threads instead of taking the scan down with it. The rules a reply must obey
	// are declared in config.ts, so discovery has nothing else to refresh.
	scan: async (since = "48h", subreddits?: readonly string[]) => {
		const subs = watched(subreddits);
		const ranAt = new Date().toISOString();
		// The listings and what we already hold, fetched together — one browser request and one store
		// query per community, on different backends, so they overlap rather than queue. `fetched` is
		// the one thing the listing must not overwrite (see `queue`): the threads whose PAGE has been
		// read, whose seed therefore carries a comment tree the listing cannot reproduce.
		const [listings, stored] = await Promise.all([
			getSubredditThreadsAll(subs, since, TARGETS.listing),
			Promise.all(subs.map((subreddit) => select({ subreddit: [subreddit] })))
		]);
		return mapLimit(subs, async (subreddit, i) => {
			const listing = listings[i];
			// Loud, and only about ITS community: the run failed, so we know nothing about this
			// subreddit — which is not the same as knowing it has no new threads.
			if (listing.status === "rejected")
				return { subreddit, error: renderError(listing.reason), queued: [] };
			const fetched = new Set(
				stored[i]
					.filter(({ seed }) => fetchedComments(seed))
					.map(({ row }) => String(row.fields["Thread URL"]))
			);
			// Labelled with the community, because scans of several subreddits interleave: the fetches
			// finish in seconds and then every one of their write fan-outs runs at once, so an unlabelled
			// m/n would be several counters sharing one stream and none of them readable.
			const queued = (
				await mapLimit(listing.value.threads, (t) => queue(t, subreddit, ranAt, fetched), {
					label: `scan r/${subreddit}`
				})
			).filter((q) => q.queued);
			return { subreddit, seen: listing.value.threads.length, queued };
		});
	},

	// engage — everything still owed on one thread, read off the thread's own DATA: qualify it if no
	// Tier says it was, then draft the reply if it earned one and no outreach was ever opened. Both
	// guards are facts a previous stage produced, so a re-run (or engagePending, or a second scan)
	// never double-judges and never double-drafts — and a run that died between the two resumes with
	// nothing to reconcile.
	//
	// Qualification is a JUDGMENT, not a Decision: it is calibrated (eval_qualify.mjs green on the
	// ground truth), so no human will ever rule on it, and a Decision born already-committed is
	// noise in the queue a human actually reads. What survives is what a later reader needs — the
	// Tier column, plus the claims as a comment ON THE THREAD PAGE, so "why was this even
	// qualified?" is answered where you are already looking. When the answer is "it shouldn't have
	// been", the fix is a line in reddit_qualified_threads.yaml and a re-run of the eval; no Decision
	// was ever involved in that loop.
	engage: async (url: string) => {
		const u = threadUrl(url);
		// ONE read of the thread row serves both the funnel guards and the judgment: the guards need
		// the Tier and the Backlog link, the judgment needs the frozen evidence, and they are one row.
		let row = await readThread(u);
		let tier = String(row.fields.Tier ?? "");
		if (tier === "No") return { url: u, skipped: true, tier };
		let screened: string | undefined;
		if (!tier) {
			// ONE question, asked twice as the evidence grows — not two prompts. The criteria, the
			// Output schema and the prompt folder are the same both times; all that differs is that the
			// second read can see what was said under the post. So there is nothing to keep in sync,
			// and the guard on the fetch is DATA, not a flag or a rung: a seed that already carries a
			// comment tree is read once, definitively, which is also what makes a crashed run resumable.
			let v = await decider.judge("qualify", subjectOf(u, row));
			if (config.prompts.qualify.resolve(v.output).advances && !hasCommentTree(row)) {
				// The pre-screen's only power is to spend a browser run, or not. Most threads never get
				// here, which is the whole reason the read is split (README #9): the listing already
				// carries the post, so this fetch buys the comments and nothing else.
				screened = tierOf(v);
				row = await refresh(row);
				v = await decider.judge("qualify", subjectOf(u, row));
			}
			const move = config.prompts.qualify.resolve(v.output);
			tier = tierOf(v);
			// The verdict, as it happens — the one line only this stage can write, because the Tier is
			// this agent's word and core cannot know what a judgment MEANT. The counter beside it says
			// how far the drain has got; this says what it decided, so a long run reads as a stream of
			// outcomes instead of a number that moves. `screened` rides along when the comment tree
			// changed the answer, which is the whole justification for paying for the second read.
			log(
				"engage",
				`${u} → ${tier}${screened && screened !== tier ? ` (post alone read ${screened})` : ""}`
			);
			// The Tier lands on the THREAD row, not only inside the verdict, and it is the whole record
			// of this judgment: it is what says the thread HAS been judged (so a re-run skips it), what
			// says it was judged OUT when it reads "No", and what the reply then sees — the reply
			// prompt's Input schema names Tier, so it freezes into the draft's Input and renders as
			// evidence (a reviewer sees what the reply answers AND how hard a fit it was). Being just a
			// column, the Notion table filters and sorts by it for free.
			await Promise.all([
				writeThread(u, { Tier: tier as RedditThreads["Tier"] }),
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
			if (!move.advances) return { url: u, tier, ...(screened ? { screened } : {}) };
		}
		// WHO wrote this, because a reply is to a PERSON and the Backlog is keyed on them. Both reads
		// at once — different tables, so they overlap instead of queueing.
		const author = authorOf(row.fields, u);
		const [outreach, siblings] = await Promise.all([outreachFor(author), siblingsOf(author)]);

		// Already talking to this human ⇒ join this thread to that conversation and stop. One outreach
		// per person, forever: a second comment from us under the same name, on the same day, is the
		// shape a mod reads as spam — and it has happened (one author cross-posted a question to two
		// subreddits and got two replies eighteen minutes apart).
		//
		// `attach` writes the THREAD's relation only, so this cannot move where their conversation
		// stands — which is the invariant, held by construction rather than by a guard.
		if (outreach) {
			await attach(u, outreach.id);
			return { url: u, tier, ...(screened ? { screened } : {}), joined: String(outreach.fields["Thread URL"] ?? outreach.id) };
		}

		// Not the thread to answer ⇒ stand down. The winner below claims us in this same run (it holds
		// the same sibling set), so nothing is written here — there is no outreach to attach to yet,
		// and inventing one for a draft that has not happened would be a row nobody will ever close.
		const best = bestOf(siblings);
		if (best && best.id !== row.id)
			return { url: u, tier, ...(screened ? { screened } : {}), deferredTo: String(best.fields["Thread URL"] ?? best.id) };

		// By KEY, not the Subject in hand: the draft's evidence must include the Tier just written, so
		// this stage reads the row back rather than judging a copy that predates its own gate.
		const draft = await decider.decide("reply", u);
		// …and the winner claims the rest of this person's threads, so they leave the worklist in the
		// SAME run instead of standing down again on the next one. Relation writes: they move nothing.
		const rest = siblings.filter((s) => s.id !== row.id);
		await Promise.all(rest.map((s) => attach(String(s.fields["Thread URL"]), draft.entity)));
		return {
			url: u,
			tier,
			...(screened ? { screened } : {}),
			status: config.prompts.reply.pending,
			draft: draft.open ?? draft.id,
			...(rest.length ? { alsoTheirs: rest.map((s) => String(s.fields["Thread URL"])) } : {})
		};
	},

	// pending — the queue DESCRIBED, and the one thing standing between "which threads?" and a bill:
	// how many the words name, split by what each of them owes, per community. It is `engagePending`
	// with the draining left out — same `pendingFilterOf`, same options — so it cannot answer for a
	// set other than the one that would run. One store query; no LLM, no browser, no write.
	//
	// Grouped on the canonical URL's community (`subOf`), never the Subreddit column, for the reason
	// every other read here does: the column keeps whatever casing a scan was handed, so grouping on
	// it forks one community into two.
	pending: async (opts: Select = {}) => {
		const rows = await queryAll(store, config.models.RedditThreads, pendingFilterOf(opts));
		const communities = [...new Set(rows.map((r) => subOf(String(r.fields["Thread URL"]))))].sort();
		return {
			...tally(rows),
			bySubreddit: communities.map((subreddit) => ({
				subreddit,
				...tally(rows.filter((r) => subOf(String(r.fields["Thread URL"])) === subreddit))
			}))
		};
	},

	// engagePending — drain `engage` over everything the words name and that still owes work: never
	// judged, plus judged-worth-answering but never drafted (a crashed run leaves threads exactly
	// there, and a filter on the first alone would strand them forever). `pendingFilterOf` above is
	// that set, said once. Engaging a thread leaves it, so the drain pages the queue with no cursor
	// to carry — including rows that only became owed while it ran.
	engagePending: (opts: Select = {}) =>
		drain(
			store,
			config.models.RedditThreads,
			pendingFilterOf(opts),
			(r) => tools.engage(String(r.fields["Thread URL"])),
			"engage"
		),

	// threads — the stored threads themselves, in the two shapes anyone ever wants them. ONE selector
	// behind both (`select`), so they can only ever differ in how much of a row they show — the same
	// two-readers rule the prompt codec obeys (src/stores/notion.codec.ts): one traversal, two
	// projections, no way for them to disagree about what the set is.
	threads: {
		// get — the INDEX: the line you scan a list by. Columns and seed scalars only; the post's own
		// words are `dump`'s job, and shipping them here would make "show me the T1 hits" a megabyte.
		get: async (opts: Select = {}) =>
			(await select(opts)).map(({ row, seed }) => ({
				url: String(row.fields["Thread URL"] ?? ""),
				subreddit: subOf(String(row.fields["Thread URL"])),
				// The seed's real title; `Name` is the truncated display label, so it is the fallback,
				// not the source — the same tolerance seedOf and evidence.ts have for an old seed.
				title: seed?.title ?? row.fields.Name ?? null,
				author: row.fields.Author ?? null,
				created: seed?.created ?? row.fields.Created ?? null,
				score: row.fields.Score ?? null,
				comments: row.fields.Comments ?? null,
				tier: row.fields.Tier ?? null
			})),

		// dump — the CORPUS: each thread's seed exactly as `queue`/`refresh` last wrote it, plus how it
		// was judged. The raw material a human labels into a ground truth (*_qualified_threads.yaml,
		// which eval_qualify.mjs reads), so the record shape is the one those files were cut from and
		// stays byte-comparable with them.
		dump: async (opts: Select = {}) =>
			(await select(opts)).map(({ row, seed }) => ({
				url: String(row.fields["Thread URL"] ?? ""),
				...(seed ?? {}),
				tier: row.fields.Tier ?? null
			}))
	},

	// backlog — the outreaches themselves: one row per PERSON we chose to engage, which is where the
	// conversation stands and what we actually posted. The peer of `threads`, and separate for the
	// reason the tables are (README #4): a thread is what Reddit says, an outreach is what WE did —
	// and who we did it to. `url` is the thread we answered; `person` is the row's identity, and the
	// other threads of theirs we passed over hang off it as relations.
	//
	// One projection, not two — a thread carries a document (hence `dump`), an outreach carries
	// scalars, so there is nothing a second shape would add. It is also the only path to `Comment URL`
	// and `Posted at`: a conversation at "Waiting for OP" has no open Decision, so the review queue
	// cannot show it and this is the one place it exists.
	backlog: {
		// Newest conversation first, and an unposted one sorts to the TOP: it is the row still waiting
		// on a human, so it is the one you came here to see. (Hence the high sentinel for a null
		// `Posted at` — it has not happened yet, which sorts later than any instant that has.)
		get: async (opts: BacklogSelect = {}) =>
			newest(
				(await queryAll(store, config.models.RedditBacklog, backlogFilterOf(opts))).map((r) => ({
					person: r.fields.Person ?? null,
					url: String(r.fields["Thread URL"] ?? ""),
					subreddit: subOf(String(r.fields["Thread URL"])),
					name: r.fields.Name ?? null,
					status: r.fields.Status ?? null,
					commentUrl: r.fields["Comment URL"] ?? null,
					postedAt: r.fields["Posted at"] ?? null
				})),
				(r) => String(r.postedAt ?? "￿"),
				opts.limit
			)
	},

	// refresh — the primitive above, exposed: re-pull one thread's page and update its seed. The
	// thread's own state only, so it never disturbs where a thread stands or anything already judged.
	// It resolves the row first, so a URL we have never scanned is refused (`notion.read: no page
	// with Thread URL = …`) rather than half-created as a row with a seed and no identity.
	refresh: async (url: string) => {
		const r = await refresh(await readThread(url));
		return { url: threadUrl(url), comments: seedOf(r)?.comments?.length ?? 0 };
	},

	// draft — manually (re-)draft a reply for one thread on its stored seed, opening (or re-opening)
	// its outreach at "Pending approval". The Decision freezes its own copy of that seed as it judges,
	// which is what makes the judgment reviewable later. No dependency to carry: the qualification is
	// a judgment, not a Decision, so there is no gate for a draft to sit behind. `context` prints what
	// the model would read and writes nothing.
	draft: (url: string) => decider.decide("reply", threadUrl(url)),
	context: (url: string) => decider.context("reply", threadUrl(url))
	// No list/show here: the Decisions table is the ENGINE's, not this agent's, so it has one
	// agent-agnostic reader — `sflock decisions list/show --agent reddit-engage`. The runtime binary
	// acts and reads its own two tables (threads, backlog); review belongs to the operator CLI
	// (README #2). Re-exposing it here was the same queue under a second name.
};
