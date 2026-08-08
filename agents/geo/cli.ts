#!/usr/bin/env node
// geo as CLI subcommands — JSON on stdout. TWO LEVERS and the reads:
//   prompts add → ask → [an Answer: the answer, the queries it searched, the sources it read — fetched]
//               → search → [the SERP in the query's body, a Result per ranked page — fetched]
// A lever acts on what you name (default: everything in its table), records what it saw, and
// fetches those pages in the same run. Then you read the four nouns and conclude. Nothing here
// judges: every verdict is a string comparison over evidence we fetched, computed at read time.
//
// FOUR NOUNS, one per table. Columns are keys, cursors and relations; the RAW OBSERVATION lives in
// the row's body; everything else is derived at read time:
//   prompts   the questions we want to win (the only thing a human writes)
//   answers   one run of one assistant on one prompt; three draws are three rows
//   queries   one (engine, query). Its body holds the latest search WHOLE — the SERP as the script
//             returned it — so rank, title, snippet and age are read out of it, never stored
//   results   one PAGE, keyed on its canonical URL however we came to look at it. Its body holds the
//             visible text — the prose the winner published — and mentions
//             are counted off it under today's BRAND, so widening an alias re-counts the corpus
//
// No status logic and no retry queue: a failed page fetch records its reason on the row and the
// next run that observes the page fetches it again. Both levers are idempotent over identity (a
// prompt, a query, a page each stay one row), so re-running after a crash reconciles nothing.

import "../../src/env.js";
import { Command } from "commander";
import { renderError } from "../../src/errors.js";
import { DEFAULT_PROVIDER, PROVIDERS, engineOf } from "./config.js";
import { tools } from "./tools.js";

const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));
const num = (s?: string) => (s ? Number(s) : undefined);

// --limit is its own attachment, because it is a property of a READING and not of a set: it trims
// the ANSWER, never the work (tools.ts `newest`; no filter honours it). So every command that PRINTS
// a set takes it, and no stage does — a stage that took it would read as a way to spend less, when
// the only honest way to do that is to name a smaller set.
const withLimit = (c: Command): Command => c.option("--limit <n>", "keep only the newest <n>");

const program = new Command()
	.name("geo")
	.description(
		"Are we cited by AI assistants, and if not, why not. Ask an assistant → harvest the queries it actually searched → search them on the index behind its web tool → fetch what ranks. The diagnosis is deterministic: it never searched / it never saw us / it saw us and skipped us / it named us."
	);

// ─── prompts ─────────────────────────────────────────────────────────────────────────────────────

const prompts = program
	.command("prompts")
	.description("The questions we want to win — the setup, and the only thing a human writes.");

prompts
	.command("add")
	.argument("<texts...>", "the questions, verbatim — wording decides which part of the index gets searched, so paste them exactly")
	.description("Record questions to measure. Upserted on the text, so adding one twice is one row.")
	.action(async (texts: string[]) => out(await tools.prompts.add(texts)));

withLimit(
	prompts
		.command("get")
		.description("One line per question: asks, cited, verdict, last asked — all DERIVED from its answers, none of them stored. `cited 0 / asks 3` is the measurement; the verdict is the best outcome across those draws.")
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
			.description("The INDEX: verdict, the queries it issued, how many sources it read, and which of those were ours. The answer TEXT is `show`'s job — it is the biggest column in the schema.")
	)
).action(async (f: { prompt?: string[]; provider?: string; verdict?: string; limit?: string }) =>
	out(await tools.answers.get({ ...f, limit: num(f.limit) }))
);

withLimit(
	withAnswerFilters(
		answers
			.command("show")
			.description("One draw in full, answer text included — what you read when the verdict says 'Passed over' and you want to know what it said instead. Newest first; defaults to 1.")
	)
).action(async (f: { prompt?: string[]; provider?: string; verdict?: string; limit?: string }) =>
	out(await tools.answers.show({ ...f, limit: num(f.limit) }))
);

// ─── queries ─────────────────────────────────────────────────────────────────────────────────────

const queries = program
	.command("queries")
	.description("One row per (engine, query) we have searched. Harvested from what an assistant actually issued — or written by hand, which is how an own-domain probe works.");

queries
	.command("add")
	.argument("<texts...>", "queries to search, e.g. 'site:reduck.ai claude visibility'")
	.option("--engine <e>", "which index", engineOf(DEFAULT_PROVIDER))
	.description("Record a query to search yourself. Same row and same stages as a harvested one — an own-domain probe is not a feature, it is a query you write instead of harvest. Provenance stays visible without a column: harvested means some draw issued it.")
	.action(async (texts: string[], f: { engine: string }) => out(await tools.queries.add(texts, f.engine)));

withLimit(
	queries
		.command("get")
		.description("One line per query: engine, harvested-or-authored, when we searched it, how many pages it currently ranks. `searchedAt` set with `ranked: 0` means we looked and found nothing — never the same as 'we never looked'. The SERP itself is the row's body; `results get --query` reads it out.")
		.option("--query <q...>", "only these queries (full key, or the text alone)")
		.option("--engine <e>", "only this index")
).action(async (f: { query?: string[]; engine?: string; limit?: string }) =>
	out(await tools.queries.get({ ...f, limit: num(f.limit) }))
);

// ─── results ─────────────────────────────────────────────────────────────────────────────────────

const results = program
	.command("results")
	.description("One row per PAGE (canonical URL): what a plain HTTP client saw at it, its visible text in the row's body. Rank is a fact about a (query, page) pair — name the query to see it.");

withLimit(
	results
		.command("get")
		.description("Status / text length / readable per page; with --query, also rank, title, snippet and age read out of that query's stored SERP. `readable` is derived from status AND length together: a 403 is bot protection and a 200 with no text is a client-rendered shell, and those need opposite fixes.")
		.option("--query <q...>", "only pages these queries currently rank — and decorate each with its rank in that SERP")
		.option("--url <urls...>", "only these pages")
		.option("--ours", "only pages on our own domain")
		.option("--mentions", "only pages that name us, counted off each stored body under today's BRAND — a body read per candidate, the one filter that costs more than a query")
		.option("--unreadable", "only pages a crawler cannot read (blocked, or a JavaScript shell)")
		.option("--source", "only pages an assistant READ — the set that provably reached the model (derived from the answers' source lists)")
		.option("--ranked", "only pages some query currently ranks")
).action(
	async (f: {
		query?: string[];
		url?: string[];
		ours?: boolean;
		mentions?: boolean;
		unreadable?: boolean;
		source?: boolean;
		ranked?: boolean;
		limit?: string;
	}) => out(await tools.results.get({ ...f, limit: num(f.limit) }))
);

results
	.command("show")
	.argument("<url>", "the page, in any shape (canonicalized)")
	.description("One page in full: its row, its mention count under today's BRAND, and the page's visible text — what the winner actually published. A 403 with a few hundred chars of challenge text is a bot wall; a 200 with almost no text is a page whose content only exists in a browser.")
	.action(async (url: string) => out(await tools.results.show(url)));

// domains — the dimension that separated the winners once on-page features stopped predicting rank.
// Fetched on demand, stored nowhere: it is a fact about a domain rather than about a row we hold.
withLimit(
	program
		.command("domains")
		.description("How much each domain in the corpus PUBLISHES, from its own sitemap: total URLs and how many look like posts, beside how often it ranks for us. `null` means the sitemap could not be read (a 404, a 429) — never that the site publishes nothing.")
		.option("--query <q...>", "only domains ranking for these queries")
		.option("--ours", "only our own domain")
).action(async (f: { query?: string[]; ours?: boolean; limit?: string }) =>
	out(await tools.domains({ ...f, limit: num(f.limit) }))
);

// ─── the two levers ──────────────────────────────────────────────────────────────────────────────
//
// No flags that decide FOR you, no dry-run, no third stage. A lever acts on what you name — or on
// everything in its table — so a run's cost is exactly the list you gave it. Run it again to
// measure again; a failed page fetch records its reason and is simply fetched again by the next
// run that observes the page.

program
	.command("ask")
	.argument("[prompts...]", "questions to ask, verbatim (default: every prompt in the table)")
	.option("--provider <p>", `which assistant (${Object.keys(PROVIDERS).join(", ")})`, DEFAULT_PROVIDER)
	.description("One new draw per prompt: record the answer and the queries it issued, and FETCH every page it read — 'what did it answer' and 'what was it looking at' are one question. Costs one claude.ai turn per prompt, on the paired browser — a device IS an account, and the answer depends on which one. A draw is a draw, not a measurement: run again for another.")
	.action(async (prompts: string[], f: { provider: string }) => out(await tools.ask(prompts, f.provider)));

program
	.command("search")
	.argument("[queries...]", "queries to search, by text or full key (default: every query in the table)")
	.description("A fresh SERP per query: the whole result page lands in the query's own body (with when and from where), replacing the last one, and every ranked page is FETCHED now — so the stored pages match the SERP that ranked them. Costs one cloud browser per query. A query whose operators Brave DROPPED records zero ranked pages and the reason, because a relaxed query is not evidence about the operator.")
	.action(async (queries: string[]) => out(await tools.search(queries)));

program.parseAsync().catch((e: unknown) => {
	console.error(renderError(e));
	process.exit(1);
});
