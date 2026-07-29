#!/usr/bin/env node
// reddit-engage as CLI subcommands — JSON on stdout. The READ-ONLY funnel, two stages joined by
// the store (the "To qualify" status is the worklist between them):
//   scan → new threads of the watched subreddits (the listing carries the full post text), queued
//   at "To qualify" — then engage → [ qualification Decision → (if good) reply draft held behind
//   it via dependsOn ] → [human gate]; plus draft (manual redraft) and list/show for the shared
//   review queue. Each stage is idempotent and monotonic on the canonical Thread URL, so either
//   re-runs safely after a crash; sending is unwired.

import "../../src/env.js";
import { Command } from "commander";
import { renderError } from "../../src/errors.js";
import { batch } from "../../src/concurrency.js";
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
	.argument("[threads...]", "thread URLs to engage; omit to drain every thread at 'To qualify'")
	.description("Qualification Decision → (if it scores well) a reply draft held behind it via dependsOn. Batched; no args drains scan's whole backlog, page by page.")
	.action(async (threads: string[]) => out(threads.length ? await batch(threads, tools.engage) : await tools.engagePending()));

program
	.command("draft")
	.argument("[threads...]", "thread URLs to (re)draft as a standalone reply Decision")
	.option("--show", "print the judgment context (contract + evidence); writes nothing")
	.description("Manually (re)draft a reply for a thread — standalone, no qualification dependency, on the frozen evidence. Batched.")
	.action(async (threads: string[], { show }) => out(show ? await batch(threads, tools.context) : await batch(threads, tools.draft)));

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
