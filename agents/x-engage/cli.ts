#!/usr/bin/env node
// x-engage as CLI subcommands — JSON on stdout. The clean, READ-ONLY flow (no posting to X):
//   scan → qualify (deterministic) → draft → [human gate], plus list/show for the shared review
//   queue and `hydrate <handle>` to record a person's posts+replies (and `hydrate <owner>` to
//   maintain the owner's voice corpus).
// Each stage is idempotent and monotonic on Post URL.

import "../../src/env.js";
import { Command } from "commander";
import { renderError } from "../../src/errors.js";
import { batch } from "../../src/concurrency.js";
import { tools } from "./tools.js";

const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

const program = new Command()
	.name("xeng")
	.description("X engagement (read-only): scan the feed → qualify (did the author answer repliers?) → draft replies in your voice as Decisions for review.");

program
	.command("scan")
	.option("--count <n>", "feed posts + posts/replies per followed person", parseInt)
	.description("Unified discovery: hydrate every Approved person (posts+replies → archive + fresh candidates at 'To qualify') AND the For You feed (known Approved author → 'To engage'). Deduped on Post URL. No reply fetch, no LLM.")
	.action(async ({ count }) => out(await tools.scan(count)));

program
	.command("qualify")
	.argument("[posts...]", "post URLs to qualify; omit to qualify every engagement at 'To qualify'")
	.option("--replies <n>", "replies to pull per post (signal depth)", parseInt)
	.description("Deterministic gate: pull replies → did the author answer a commenter? Engagement → To engage | Not qualified | (defer). Batched (≤4 parallel).")
	.action(async (posts: string[], { replies }) =>
		out(posts.length ? await batch(posts, (p) => tools.qualify(p, replies)) : await tools.qualifyPending(replies))
	);

program
	.command("draft")
	.argument("[posts...]", "post URLs to draft; omit to draft every engagement at 'To engage'")
	.option("--show", "print the judgment context (contract + evidence + your voice block); writes nothing")
	.description("Judge each post against the 'X Reply' contract (LLM), grounded in your voice → one Decision; engagement → Draft pending review.")
	.action(async (posts: string[], { show }) => {
		if (show) return out(await batch(posts, tools.context));
		out(posts.length ? await batch(posts, tools.draft) : await tools.draftPending());
	});

program
	.command("hydrate")
	.argument("<handle>", "an X handle (@handle, bare handle, or profile URL)")
	.option("--count <n>", "posts/replies to pull per tab", parseInt)
	.description("Record a person's own posts + replies into the X Posts/X Replies archive (with Author) and queue the fresh (<48h) ones as candidates. `hydrate <owner>` maintains your voice corpus (queues nothing). Idempotent.")
	.action(async (handle: string, { count }) => out(await tools.hydrate(handle, count)));

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
