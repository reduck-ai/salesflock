#!/usr/bin/env node
// geo as CLI subcommands — JSON on stdout. TWO LEVERS and the reads:
//   prompts add → ask → [an Answer; a Search per query it issued (cross-validated on its index);
//                        a look per page it read or that ranked]
//   search      → [a Search per query named; a look per ranked page]  — the investigation door
// A lever acts on what you name (default: everything it knows), records what it saw as rows that
// are CREATED COMPLETE and never touched, and fetches those pages in the same run. Then you read
// the four nouns and conclude. Nothing here judges: every verdict is a string comparison over
// evidence we fetched, computed at read time.
//
// FOUR NOUNS: one intent table and three append-only logs. Columns are keys, moments and
// circumstances; the RAW OBSERVATION lives in the row's body; everything else is derived at read:
//   prompts   the questions we want to win (the only thing a human writes; the only intent rows)
//   answers   one draw. Three draws of a question are three rows — that variance IS the measurement
//   searches  one query DONE, Claude's (its `Answer` relation names the draw — the ask tool
//             cross-validated it on the same index its web tool reads) or yours (no Answer). The
//             SERP whole in the row's body — rank, title, snippet, age read out of it, never stored
//   results   one LOOK — one page fetched at one instant, its visible text in the body, mentions
//             counted off it under today's BRAND. Its `Answer` relation = the model read it in that draw
//
// RELATIONS RECORD CAUSATION (written from the side complete at write time); VALUES record IDENTITY
// across time (Key, URL). No status logic and no retry queue — re-running appends fresh
// observations; nothing reconciles.

import "../../src/env.js";
import { Command } from "commander";
import { renderError } from "../../src/errors.js";
import { DEFAULT_PROVIDER, PROVIDERS, engineOf } from "./config.js";
import { tools } from "./tools.js";

const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));
const num = (s?: string) => (s ? Number(s) : undefined);

// --limit is its own attachment, because it is a property of a READING and not of a set: it trims
// the ANSWER, never the work (tools.ts `newest`; no filter honours it). So every command that PRINTS
// a set takes it, and no lever does — a lever that took it would read as a way to spend less, when
// the only honest way to do that is to name a smaller set.
const withLimit = (c: Command): Command => c.option("--limit <n>", "keep only the newest <n>");

const program = new Command()
	.name("geo")
	.description(
		"Are we cited by AI assistants, and if not, why not. Ask an assistant → its queries are cross-validated on the index behind its web tool → everything it read or that ranked is fetched. The diagnosis is deterministic: it never searched / it never saw us / it saw us and skipped us / it named us."
	);

// ─── prompts ─────────────────────────────────────────────────────────────────────────────────────

const prompts = program
	.command("prompts")
	.description("The questions we want to win — the panel, and the only thing a human writes.");

prompts
	.command("add")
	.argument("<texts...>", "the questions, verbatim — wording decides which part of the index gets searched, so paste them exactly")
	.description("Record questions to measure. Upserted on the text, so adding one twice is one row.")
	.action(async (texts: string[]) => out(await tools.prompts.add(texts)));

withLimit(
	prompts
		.command("get")
		.description("The scoreboard: one line per question — asks, cited, verdict, last asked — all DERIVED from the logs, none stored. `cited 0 / asks 3` is the measurement; the verdict is the best outcome across those draws.")
		.option("--prompt <texts...>", "only these questions")
		.option("--verdict <v>", `only this verdict ("Cited", "Passed over", "Not retrieved", "No search")`)
).action(async (f: { prompt?: string[]; verdict?: string; limit?: string }) =>
	out(await tools.prompts.get({ ...f, limit: num(f.limit) }))
);

// ─── answers ─────────────────────────────────────────────────────────────────────────────────────

const answers = program
	.command("answers")
	.description("One row per draw — one run of one assistant. Three draws of a question are three rows, because it answers differently each time and that variance IS the measurement.");

const withAnswerFilters = (c: Command): Command =>
	c
		.option("--prompt <texts...>", "only draws of these questions")
		.option("--provider <p>", `only this assistant (${Object.keys(PROVIDERS).join(", ")})`)
		.option("--verdict <v>", `only this verdict (adds "Truncated" — an answer cut off mid-stream, which is not a measurement)`);

withLimit(
	withAnswerFilters(
		answers
			.command("get")
			.description("The INDEX: verdict, the queries it issued (the Searches sharing its Conversation), whether it read us. The answer TEXT is `show`'s job — it is the biggest column in the schema.")
	)
).action(async (f: { prompt?: string[]; provider?: string; verdict?: string; limit?: string }) =>
	out(await tools.answers.get({ ...f, limit: num(f.limit) }))
);

withLimit(
	withAnswerFilters(
		answers
			.command("show")
			.description("One draw in full — answer text, its queries, and every page it read — what you open when the verdict says 'Passed over' and you want to know what it said instead. Newest first; defaults to 1.")
	)
).action(async (f: { prompt?: string[]; provider?: string; verdict?: string; limit?: string }) =>
	out(await tools.answers.show({ ...f, limit: num(f.limit) }))
);

// ─── searches ────────────────────────────────────────────────────────────────────────────────────

const searches = program
	.command("searches")
	.description("One row per query DONE — Claude's (Answer relation set) or yours (none). The SERP time series: group by key for rank drift, by egress for comparability.");

withLimit(
	searches
		.command("get")
		.description("One line per search: key, whose (claude/direct, off the Answer relation), when, from where, how many looks it ranked (the Results relation), and why it failed if it did. The SERP itself is the row's body; `results get --query` reads it out.")
		.option("--query <q...>", "only these queries (full key, or the text alone)")
		.option("--engine <e>", "only this index")
).action(async (f: { query?: string[]; engine?: string; limit?: string }) =>
	out(await tools.searches.get({ ...f, limit: num(f.limit) }))
);

// ─── results ─────────────────────────────────────────────────────────────────────────────────────

const results = program
	.command("results")
	.description("One row per LOOK — one page fetched at one instant, its visible text in the body, plus the markup facts frozen at fetch time (canonical, the publisher's claimed date, schema.org types, heading counts — each labeled for whose claim it is). Default reads show the newest look per page; --history shows them all (content drift). Rank is a fact about a (query, page) pair — name the query to see it.");

withLimit(
	results
		.command("get")
		.description("Status / text length / readable per page; with --query, also rank, title, snippet and age read out of that query's newest honoured SERP. `readable` derives from status AND length together (a 403 is bot protection, a 200 with no text is a client-rendered shell — opposite fixes); a status-0 look reads unknown, never false.")
		.option("--query <q...>", "only pages these queries currently rank — and decorate each with its rank in that SERP")
		.option("--url <urls...>", "only these pages")
		.option("--ours", "only pages on our own domain")
		.option("--mentions", "only pages that name us, counted off each stored body under today's BRAND — a body read per candidate, the one filter that costs more than a query")
		.option("--unreadable", "only pages a crawler cannot read (blocked, or a JavaScript shell)")
		.option("--source", "only pages a model READ (Answer relation set) — the set that provably reached it")
		.option("--ranked", "only pages some Search ranked (Search relation set) — ever-ranked at fetch time; with the default newest-look-per-page view this reads as currently ranked")
		.option("--history", "every look, not just the newest per page")
).action(
	async (f: {
		query?: string[];
		url?: string[];
		ours?: boolean;
		mentions?: boolean;
		unreadable?: boolean;
		source?: boolean;
		ranked?: boolean;
		history?: boolean;
		limit?: string;
	}) => out(await tools.results.get({ ...f, limit: num(f.limit) }))
);

results
	.command("show")
	.argument("<url>", "the page, in any shape (canonicalized)")
	.description("One page ACROSS TIME: every look of it newest-first, the newest text in full with its mention count under today's BRAND. A 403 with a few hundred chars of challenge text is a bot wall; a 200 with almost no text is a page whose content only exists in a browser.")
	.action(async (url: string) => out(await tools.results.show(url)));

// domains — the dimension that separated the winners once on-page features stopped predicting rank.
// Fetched on demand, stored nowhere: it is a fact about a domain rather than about a row we hold.
withLimit(
	program
		.command("domains")
		.description("How much each domain in the current SERPs PUBLISHES, from its own sitemap: total URLs and how many look like posts, beside how often it ranks for us. `null` means the sitemap could not be read (a 404, a 429) — never that the site publishes nothing.")
		.option("--query <q...>", "only domains ranking for these queries")
		.option("--ours", "only our own domain")
).action(async (f: { query?: string[]; ours?: boolean; limit?: string }) =>
	out(await tools.domains({ ...f, limit: num(f.limit) }))
);

// ─── the two levers ──────────────────────────────────────────────────────────────────────────────
//
// No flags that decide FOR you, no dry-run, no third stage. A lever acts on what you name — or on
// everything it knows — and every run APPENDS observations; nothing is ever overwritten, so re-running
// after a crash reconciles nothing. Run again to measure again.

program
	.command("ask")
	.argument("[prompts...]", "questions to ask, verbatim (default: every prompt in the panel)")
	.option("--provider <p>", `which assistant (${Object.keys(PROVIDERS).join(", ")})`, DEFAULT_PROVIDER)
	.description("THE DAILY LEVER. One new draw per prompt: record the answer, cross-validate every query it issued on the index its web tool reads (Claude's SERP IS Brave's SERP), and fetch every page it read or that ranked — the whole funnel in one act. Costs one claude.ai turn + one cloud browser per issued query, on the paired browser — a device IS an account, and the answer depends on which one.")
	.action(async (prompts: string[], f: { provider: string }) => out(await tools.ask(prompts, f.provider)));

program
	.command("search")
	.argument("[queries...]", `queries to search, by text or full key (default: re-audit every key ever done). Authoring a query IS searching it — e.g. geo search "site:reduck.ai"`)
	.description("The investigation door: a fresh SERP per query — a new Search row (the whole result page in its body, with when and from where) and a look per ranked page. A query whose operators Brave DROPPED records the SERP and the reason but ranks nothing, because a relaxed query is not evidence about the operator.")
	.action(async (queries: string[]) => out(await tools.search(queries)));

program.parseAsync().catch((e: unknown) => {
	console.error(renderError(e));
	process.exit(1);
});
