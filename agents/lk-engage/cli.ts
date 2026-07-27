#!/usr/bin/env node
// lk-engage as CLI subcommands — JSON on stdout. The bare-minimum, READ-ONLY flow (no posting):
//   scan (my feed + Watched People) → engage [ qualification Decision → (if good) comment draft ]
//   → [human gate], plus list/show for the shared review queue.
// Each stage is idempotent and monotonic on Post URL.

import "../../src/env.js";
import { Command } from "commander";
import { renderError } from "../../src/errors.js";
import { batch } from "../../src/concurrency.js";
import { tools } from "./tools.js";

const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

const program = new Command()
	.name("lkeng")
	.description("LinkedIn engagement (read-only): scan my feed + Watched People → qualify posts → draft comments in Daniel's voice as Decisions for review.");

program
	.command("scan")
	.option("--count <n>", "posts per watched person, and feed posts to load", parseInt)
	.description("Unified discovery: the recent posts of every Watched Person (People.Watch ☑) AND my home feed → fresh (<48h) candidates at 'To qualify'. Deduped on Post URL. No LLM.")
	.action(async ({ count }) => out(await tools.scan(count)));

program
	.command("engage")
	.argument("[posts...]", "post URLs to engage; omit to run over every engagement at 'To qualify'")
	.description("Qualification Decision → (if it scores well) a comment draft held behind it via dependsOn. Batched (≤4 parallel).")
	.action(async (posts: string[]) => out(posts.length ? await batch(posts, tools.engage) : await tools.engagePending()));

program
	.command("draft")
	.argument("[posts...]", "post URLs to (re)draft as a standalone comment Decision")
	.option("--show", "print the judgment context (contract + evidence); writes nothing")
	.description("Manually (re)draft a comment for a post — standalone, no qualification dependency. Batched (≤4 parallel).")
	.action(async (posts: string[], { show }) => out(show ? await batch(posts, tools.context) : await batch(posts, tools.draft)));

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
