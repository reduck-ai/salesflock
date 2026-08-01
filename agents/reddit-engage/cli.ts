#!/usr/bin/env node
// reddit-engage as CLI subcommands — JSON on stdout. The READ-ONLY funnel, two stages joined by
// the store (the "To qualify" status is the worklist between them):
//   scan → new threads of the watched subreddits (the listing carries the full post text), queued
//   at "To qualify" — then engage → [ qualify as a judgment, kept as the thread's Tier + a comment
//   on its page → (if good) a reply draft, the one Decision ] → [human gate]; plus draft (manual
//   redraft) and list/show for the shared review queue. Each stage is idempotent and monotonic on
//   the canonical Thread URL, and the thread's rung says what is still owed, so either re-runs
//   safely after a crash; sending is unwired.

import "../../src/env.js";
import { Command } from "commander";
import { renderError } from "../../src/errors.js";
import { batch } from "../../src/concurrency.js";
import { stringify as stringifyYaml } from "yaml";
import { tools } from "./tools.js";

const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

const program = new Command()
	.name("rdt")
	.description("Reddit engagement (read-only): scan the watched subreddits' new threads → qualify (title + post) → draft replies, all as Decisions for review.");

program
	.command("scan")
	.argument("[subreddits...]", "subreddits to scan; omit for the config watchlist")
	.option("--since <window>", `how far back — ISO date or shorthand ("48h", "7d")`, "48h")
	.description("Discovery: each subreddit's threads newer than --since → new ones queued with evidence (title + full post) at 'To qualify'. Deduped on Thread URL. No LLM — judge with `engage`.")
	.action(async (subreddits: string[], { since }) => out(await tools.scan(since, subreddits.length ? subreddits : undefined)));

program
	.command("engage")
	.argument("[threads...]", "thread URLs to engage; omit to drain the backlog ('To qualify' + 'To engage')")
	.description("Qualify (a judgment: Tier on the thread, claims as a page comment — no Decision) — the post alone first, then the full thread with its comments for anything that survives → if it still scores well, a reply draft for review. Batched; no args drains the whole backlog, page by page.")
	.action(async (threads: string[]) => out(threads.length ? await batch(threads, tools.engage) : await tools.engagePending()));

program
	.command("refresh")
	.argument("<threads...>", "thread URLs to re-pull from their own page")
	.description("Re-read a thread from its page and re-freeze its evidence (post + full comment tree, score, count). Evidence only — never touches Status or Tier, so it is safe at any point in the funnel. Batched.")
	.action(async (threads: string[]) => out(await batch(threads, tools.refresh)));

program
	.command("draft")
	.argument("[threads...]", "thread URLs to (re)draft as a standalone reply Decision")
	.option("--show", "print the judgment context (contract + evidence); writes nothing")
	.description("Manually (re)draft a reply for a thread, on the frozen evidence. Batched.")
	.action(async (threads: string[], { show }) => out(show ? await batch(threads, tools.context) : await batch(threads, tools.draft)));

program
	.command("dump")
	.argument("<subreddit>", "subreddit whose stored threads to dump (r/ prefix optional)")
	.option("--limit <n>", "keep only the newest <n> threads (the dump is newest-first)")
	.description("Every stored thread of one subreddit as raw YAML on stdout — the frozen evidence (title + full post) plus current Status, newest first. Reads everything, writes nothing.")
	.action(async (subreddit: string, { limit }: { limit?: string }) => {
		const all = await tools.dump(subreddit);
		const threads = limit ? all.slice(0, Number(limit)) : all;
		console.error(`r/${subreddit.replace(/^r\//i, "")}: ${threads.length} of ${all.length} threads`);
		console.log(stringifyYaml(threads, { lineWidth: 0 }));
	});

program
	.command("list")
	.description("Decisions awaiting a human verdict (the shared review queue): id, name, kind, app link.")
	.action(async () => out(await tools.list()));

program
	.command("show")
	.argument("<decision>", "Decision id, Notion URL, or app URL")
	.description("One decision: the judgment (output, statements, evidence), plus the human diff once reviewed.")
	.action(async (decision: string) => out(await tools.show(decision)));

program.parseAsync().catch((e: unknown) => {
	console.error(renderError(e));
	process.exit(1);
});
