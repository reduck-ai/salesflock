#!/usr/bin/env node
// geo as CLI subcommands — JSON on stdout. Three stages joined by the store, each owed off data the
// one before it had to write:
//   prompts add → ask → [an Answer: the answer, the queries it searched, the sources it read]
//               → search → [a Result per ranked page] → read → [status, text length, mentions]
// Then you read the four nouns and conclude. Nothing here judges: every verdict is a string
// comparison over evidence we fetched, computed at read time, so there is no model and no gate.
//
// FOUR NOUNS, one per table, each with its own filters — because the tables carry different facts:
//   prompts   the questions we want to win (the only thing a human writes)
//   answers   one run of one assistant on one prompt; three draws are three rows
//   queries   one (engine, query) we have searched
//   results   one (query, page), and what a plain HTTP client saw at it
//
// Every stage is idempotent and reads what it owes off the data itself, so any of them re-runs
// safely after a crash with nothing to reconcile.

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
		.description("One line per query: engine, harvested-or-authored, when we searched it, how many results it holds. `searchedAt` set with `results: 0` means we looked and found nothing — never the same as 'we never looked'.")
		.option("--query <q...>", "only these queries (full key, or the text alone)")
		.option("--engine <e>", "only this index")
).action(async (f: { query?: string[]; engine?: string; limit?: string }) =>
	out(await tools.queries.get({ ...f, limit: num(f.limit) }))
);

// ─── results ─────────────────────────────────────────────────────────────────────────────────────

const results = program
	.command("results")
	.description("One row per (query, page): where it ranks, and what a plain HTTP client saw at it.");

withLimit(
	results
		.command("get")
		.description("Rank, title, snippet, age, plus status / text length / mentions once fetched. `readable` is derived from status AND length together: a 403 is bot protection and a 200 with no text is a client-rendered shell, and those need opposite fixes.")
		.option("--query <q...>", "only results of these queries")
		.option("--url <urls...>", "only these pages")
		.option("--ours", "only pages on our own domain")
		.option("--mentions", "only pages that already name us — the cheap lever: they rank, and they can be updated")
		.option("--unreadable", "only pages a crawler cannot read (blocked, or a JavaScript shell)")
).action(async (f: { query?: string[]; url?: string[]; ours?: boolean; mentions?: boolean; unreadable?: boolean; limit?: string }) =>
	out(await tools.results.get({ ...f, limit: num(f.limit) }))
);

// ─── the stages ──────────────────────────────────────────────────────────────────────────────────

const withDraws = (c: Command): Command =>
	c
		.option("--draws <n>", "how many answers each question should have — ONE ASK IS A DRAW, NOT A MEASUREMENT: the assistant reformulates differently, or does not search at all, on the next run. What is owed is `answers < draws`, so this accumulates rather than re-asking.", "1")
		.option("--provider <p>", `which assistant (${Object.keys(PROVIDERS).join(", ")})`, DEFAULT_PROVIDER)
		.option("--prompt <texts...>", "only these questions");

const withDryRun = (c: Command): Command =>
	c.option("--dry-run", "count what is owed instead of doing it — through the SAME filters the stages drain, so it cannot describe a different set than the run. Reads the store and nothing else.");

withDryRun(
	withDraws(
		program
			.command("ask")
			.description("Ask each question that owes a draw, record the answer plus the queries it issued and the sources it read, and open a Query row per reformulation. Runs on the paired browser — a device IS an account, and the answer depends on which one.")
	)
).action(async (f: { draws: string; provider: string; prompt?: string[]; dryRun?: boolean }) => {
	const o = { prompt: f.prompt };
	out(f.dryRun ? await tools.pending(Number(f.draws), o) : await tools.askPending(Number(f.draws), f.provider, o));
});

withDryRun(
	program
		.command("search")
		.description("Search every query that has never been searched, on its own index, all in one request. A query whose operators Brave DROPPED records zero results — those hits are a relaxed query over the whole web, not evidence about the operator.")
).action(async (f: { dryRun?: boolean }) =>
	out(f.dryRun ? (await tools.pending()).search : await tools.searchPending())
);

withDryRun(
	program
		.command("read")
		.description("Fetch every result that has never been fetched — plain HTTP, no browser, because a crawler has none either. Records status, text length and how many times we are named. Also re-reads anything counted under an older BRAND definition.")
).action(async (f: { dryRun?: boolean }) =>
	out(f.dryRun ? (await tools.pending()).read : await tools.readPending())
);

withDryRun(
	withDraws(
		program
			.command("advance")
			.description("ask → search → read, one pass over everything owed. The stages are strictly ordered (a query exists once an answer issued it; a result once a query was searched), so one command is one pass.")
	)
).action(async (f: { draws: string; provider: string; prompt?: string[]; dryRun?: boolean }) => {
	const o = { prompt: f.prompt };
	out(f.dryRun ? await tools.pending(Number(f.draws), o) : await tools.advance(Number(f.draws), f.provider, o));
});

program.parseAsync().catch((e: unknown) => {
	console.error(renderError(e));
	process.exit(1);
});
