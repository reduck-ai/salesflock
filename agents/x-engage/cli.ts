#!/usr/bin/env node
// x-engage as CLI subcommands — JSON on stdout. The clean flow: scan → draft → [human gate] → post,
// plus list/show for the shared review queue. Each stage is idempotent and monotonic on Post URL.

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
	.description("X engagement: scan the feed for posts whose author answers repliers, draft replies as Decisions, post the approved ones.");

program
	.command("scan")
	.option("--count <n>", "feed posts to scan", parseInt)
	.option("--replies <n>", "replies to pull per post (signal depth)", parseInt)
	.description("For You feed → keep posts whose author answered a replier → write X Engagements (To draft). No LLM, no Decision.")
	.action(async ({ count, replies }) => out(await tools.scan(count, replies)));

program
	.command("draft")
	.argument("[posts...]", "post URLs to draft; omit to draft every engagement at 'To draft'")
	.option("--show", "print the judgment context (contract + frozen evidence); writes nothing")
	.description("Judge each post against the 'X Reply' contract (LLM) → one Decision; engagement → Draft pending review.")
	.action(async (posts: string[], { show }) => {
		if (show) return out(await batch(posts, tools.context));
		out(posts.length ? await batch(posts, tools.draft) : await tools.draftPending());
	});

program
	.command("post")
	.argument("[posts...]", "post URLs to reply to; omit to post every 'Approved' engagement")
	.description("Post the committed reply of each Approved engagement via reply_to_tweet; engagement → Posted.")
	.action(async (posts: string[]) => out(posts.length ? await batch(posts, tools.post) : await tools.postApproved()));

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
