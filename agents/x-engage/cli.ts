#!/usr/bin/env node
// x-engage as CLI subcommands — JSON on stdout. The clean, READ-ONLY flow (no posting to X):
//   scan → qualify (deterministic) → draft → [human gate], plus list/show for the shared review
//   queue and update-posts / update-replies to maintain the owner's voice corpus.
// Each stage is idempotent and monotonic on Post URL.

import "../../src/env.js";
import { Command } from "commander";
import { renderError } from "../../src/errors.js";
import { mapLimit } from "../../src/concurrency.js";
import { tools } from "./tools.js";

const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

// Batch a per-post tool, surfacing a failed item as {post, error} rather than aborting the run;
// a non-zero exit still flags that something failed (never silently "successful").
const batch = async <R>(posts: string[], fn: (p: string) => Promise<R>) => {
	const results = await mapLimit(posts, (p) => fn(p).catch((e: unknown) => ({ post: p, error: renderError(e) })));
	if (results.some((r) => r && typeof r === "object" && "error" in r)) process.exitCode = 1;
	return results;
};

const program = new Command()
	.name("xeng")
	.description("X engagement (read-only): scan the feed → qualify (did the author answer repliers?) → draft replies in your voice as Decisions for review.");

program
	.command("scan")
	.option("--count <n>", "feed posts to scan", parseInt)
	.description("For You feed → X Engagements at 'To qualify' (or 'To engage' if the author is a known Approved person). No reply fetch, no LLM.")
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
	.command("update-posts")
	.argument("<handle>", "the owner's X handle (@handle, bare handle, or profile URL)")
	.option("--count <n>", "posts to pull", parseInt)
	.description("Refresh the owner's own posts into X Posts — the voice corpus that grounds the drafter. Idempotent.")
	.action(async (handle: string, { count }) => out(await tools.updatePosts(handle, count)));

program
	.command("update-replies")
	.argument("<handle>", "the owner's X handle (@handle, bare handle, or profile URL)")
	.option("--count <n>", "replies to pull", parseInt)
	.description("Scrape the owner's own replies (/with_replies) into X Replies — the voice corpus that grounds the drafter. Idempotent.")
	.action(async (handle: string, { count }) => out(await tools.updateReplies(handle, count)));

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
