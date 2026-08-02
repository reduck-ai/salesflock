#!/usr/bin/env node
// reddit-engage as CLI subcommands — JSON on stdout. Two stages joined by the store, and what marks
// a thread's place between them is DATA, not a rung:
//   scan → the watched subreddits' new threads (the listing carries the full post text), recorded as
//   the thread's seed and nothing else — then engage → [ qualify as a judgment, kept as its Tier + a
//   comment on its page → (if good) a reply draft, the one Decision, opening an outreach at "Pending
//   approval" ] → [human gate, in the review app, which POSTS the reply and lands the outreach at
//   "Waiting for OP"]; plus draft, a manual redraft.
// TWO nouns to look at, one per table this agent owns: `threads` (what Reddit says, how we judged it)
// and `backlog` (our outreaches — where each conversation stands, what we posted). Each has its own
// filters — and `engage` speaks the THREAD ones, so the same words that read a set also select the
// set it works on; `--dry-run` then prints what that set would cost instead of paying it.
// The third table, Decisions, is the ENGINE's and has an agent-agnostic reader of its own:
// `sflock decisions list/show --agent reddit-engage` — what a human must rule on, with the evidence.
// Every stage is idempotent on the canonical Thread URL and reads what it owes off the thread's own
// data (no Tier ⇒ judge it; a good Tier and no outreach ⇒ draft it), so any of them re-runs safely
// after a crash with nothing to reconcile.

import "../../src/env.js";
import { Command } from "commander";
import { renderError } from "../../src/errors.js";
import { batch } from "../../src/concurrency.js";
import { stringify as stringifyYaml } from "yaml";
import { tools } from "./tools.js";

const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

// TWO vocabularies, one per noun, because there are two tables and they carry different facts: a
// THREAD is what Reddit says and how we judged it; an OUTREACH is where our conversation stands and
// what we posted. Only the identity flags are shared (both tables key on the canonical Thread URL,
// which is what lets you ask either about the same thread). Each is declared ONCE and attached to
// every command that selects with it, so two commands can never drift about what the words mean;
// the tools compile them through `filterOf` / `backlogFilterOf` (tools.ts).
type Ident = { url?: string[]; subreddit?: string[]; limit?: string };
const withIdent = (c: Command): Command =>
	c
		.option("--url <urls...>", "only these threads, by URL (any Reddit shape; canonicalized)")
		.option("--subreddit <names...>", "only these subreddits (r/ prefix optional); omit for all");

// --limit is its own attachment, because it is a property of a READING and not of a set: it trims
// the ANSWER, never the work (tools.ts `newest`; no filter honours it). So every command that PRINTS
// a set takes it — and `engage`, where the answer IS the work, must not, or it would read as a way
// to spend less when the only honest way to do that is to name a smaller set.
const withLimit = (c: Command): Command => c.option("--limit <n>", "keep only the newest <n>");

type ThreadFlags = Ident & { tier?: string; since?: string };
const withThreadFilters = (c: Command): Command =>
	withIdent(c)
		.option("--tier <tier>", "only threads judged T1, T2 or No (omit for every thread)")
		.option("--since <window>", `only threads created since — ISO date or shorthand ("48h", "7d")`);

// The Backlog's own flags. `--status` names that table's own column, which is the only place the
// word means anything; `--since` reads `Posted at`, because a different table keeps a different clock.
type BacklogFlags = Ident & { status?: string; since?: string };
const withBacklogFilters = (c: Command): Command =>
	withIdent(c)
		.option("--status <state>", `only outreaches at this state ("Pending approval", "Waiting for OP", "Dropped")`)
		.option("--since <window>", `only outreaches posted since — ISO date or shorthand ("48h", "7d")`);

// Commander hands every option back as a string; the tools take a number. One conversion, here.
const selectOf = <T extends { limit?: string }>(f: T) => ({ ...f, limit: f.limit ? Number(f.limit) : undefined });

const program = new Command()
	.name("rdt")
	.description("Reddit engagement: scan the watched subreddits' new threads → qualify (title + post) → draft replies as Decisions. Confirming a draft in the review app POSTS it.");

program
	.command("scan")
	.argument("[subreddits...]", "subreddits to scan; omit for the config watchlist")
	.option("--since <window>", `how far back — ISO date or shorthand ("48h", "7d")`, "48h")
	.description("Discovery: each subreddit's threads newer than --since, recorded with their seed (title + full post). The seed only — no funnel state, no LLM, so re-scanning a thread already deep in the funnel cannot disturb it. Deduped on Thread URL. Judge with `engage`.")
	.action(async (subreddits: string[], { since }) => out(await tools.scan(since, subreddits.length ? subreddits : undefined)));

withThreadFilters(
	program
		.command("engage")
		.argument("[threads...]", "thread URLs to engage — sugar for --url; omit to take everything the filters name")
		.description("Qualify (a judgment: Tier on the thread, claims as a page comment — no Decision) — the post alone first, then the full thread with its comments for anything that survives → if it still scores well, a reply draft opens an outreach at 'Pending approval'. Works on the threads the filters name that still OWE work (never judged, or judged good and never drafted); no filters ⇒ everything owed, page by page.")
		.option("--dry-run", "describe that queue instead of draining it: how many threads are owed, split by what each owes (a qualify call, or only a draft), per community. Reads the store and nothing else — no LLM, no browser, no write.")
).action(async (threads: string[], f: ThreadFlags & { dryRun?: boolean }) => {
	// The positional URLs ARE --url, so there is ONE path through this command: the words name a set,
	// and the flag says whether to describe it or drain it. Naming a thread therefore no longer
	// bypasses the owed check — a thread that owes nothing comes back as an empty result instead of
	// being silently re-drafted, and forcing a redraft is what `draft` is for (it always was; the
	// positional path was a second, undocumented way to do it). Nothing is ignored, because nothing
	// is bypassed: every word narrows the same filter.
	const opts = selectOf({ ...f, url: [...threads, ...(f.url ?? [])] });
	out(f.dryRun ? await tools.pending(opts) : await tools.engagePending(opts));
});

// threads — one selector, two projections. The action names what you do with the set (read it /
// save it); the flags name the set, and they are the same flags either way.
const threads = program
	.command("threads")
	.description("The stored Reddit threads: select with the thread filters, then read them (get) or save them (dump).");

withLimit(
	withThreadFilters(
		threads
			.command("get")
			.description("The INDEX: one line per thread — url, subreddit, title, author, created, score, comments, tier. Newest first, JSON on stdout. The post's own text is `dump`'s job.")
	)
).action(async (f: ThreadFlags) => out(await tools.threads.get(selectOf(f))));

withLimit(
	withThreadFilters(
		threads
			.command("dump")
			.description("The CORPUS: each thread's seed (title + full post, and the comment tree once fetched) plus how it was judged, as YAML on stdout — the raw material to hand-label into a ground truth. Newest first.")
	)
).action(async (f: ThreadFlags) => {
	const rows = await tools.threads.dump(selectOf(f));
	console.error(`${rows.length} threads`);
	console.log(stringifyYaml(rows, { lineWidth: 0 }));
});

// backlog — the outreaches: one row per thread we chose to engage. The peer of `threads`, with its
// own flags, because the two tables carry different facts. One projection: an outreach is scalars.
const backlog = program
	.command("backlog")
	.description("Our outreaches — one per engaged thread: where the conversation stands and what we posted.");

withLimit(
	withBacklogFilters(
		backlog
			.command("get")
			.description("One line per outreach — url, subreddit, name, status, commentUrl, postedAt. Unposted first, then newest, JSON on stdout. The only path to what we actually posted, and the only way to see a 'Waiting for OP' conversation (it has no open Decision, so `sflock decisions list` cannot show it).")
	)
).action(async (f: BacklogFlags) => out(await tools.backlog.get(selectOf(f))));

program
	.command("refresh")
	.argument("<threads...>", "thread URLs to re-pull from their own page")
	.description("Re-read a thread from its own page and update what we store about it: the seed (post + full comment tree), score, comment count. Those three columns only — never the Tier, never the outreach, and never a Decision already made (a judgment froze its own copy). Safe wherever a thread stands. Batched.")
	.action(async (threads: string[]) => out(await batch(threads, tools.refresh)));

program
	.command("draft")
	.argument("[threads...]", "thread URLs to (re)draft as a standalone reply Decision")
	.option("--show", "print the judgment context (contract + evidence); writes nothing")
	.description("Manually (re)draft a reply for a thread, on its stored seed — opening (or re-opening) its outreach at 'Pending approval'. The Decision freezes its own copy as it judges. Batched.")
	.action(async (threads: string[], { show }) => out(show ? await batch(threads, tools.context) : await batch(threads, tools.draft)));

program.parseAsync().catch((e: unknown) => {
	console.error(renderError(e));
	process.exit(1);
});
