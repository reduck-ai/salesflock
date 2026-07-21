#!/usr/bin/env node
// The funnel tools as CLI subcommands — JSON on stdout so the agent reads each result. The clean
// four stages: search → pre-qualify → enrich → qualify, plus list/show for the review queue.

import "../../src/env.js";
import { Command } from "commander";
import { renderError } from "../../src/errors.js";
import { mapLimit } from "../../src/concurrency.js";
import { tools } from "./tools.js";

const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

// Batch a per-profile tool over many, ≤4 in flight (the shared reduck cap throttles scrapes under
// it). Resilient by construction: one profile's failure becomes an {profile, error} entry rather
// than aborting the whole run — a batch never loses its good results to one bad scrape. The error
// still flows to the shell: if any item failed, the process exits non-zero (a run is never silently
// "successful" while an item errored).
const batch = async <R>(profiles: string[], fn: (p: string) => Promise<R>) => {
	const results = await mapLimit(profiles, (p) =>
		fn(p).catch((e: unknown) => ({ profile: p, error: renderError(e) }))
	);
	if (results.some((r) => r && typeof r === "object" && "error" in r)) process.exitCode = 1;
	return results;
};

const program = new Command()
	.name("rpa")
	.description("Former-RPA-PM lead-gen: search → pre-qualify (deterministic) → enrich → qualify.");

program
	.command("search")
	.argument("<query>", `Google query, e.g. site:www.linkedin.com/in Ex-UiPath senior product manager`)
	.option("--page <n>", "0-based results page (→ Google &start=page*10); each page is a full ~10-card SERP, near-disjoint from the others", parseInt)
	.description("Discover profiles via Google (one run of one results page); write Person stubs + Sourcing + new Leads (To pre-qualify).")
	.action(async (query, { page }) => out(await tools.search(query, page)));

program
	.command("pre-qualify")
	.argument("<profiles...>", "one or more profile URLs or bare publicIds")
	.description("Deterministic gate: experience-only pull → was a senior PM at an RPA vendor and has left? Lead → To enrich | Not qualified. Batched (≤4 parallel reduck runs).")
	.action(async (profiles) => out(await batch(profiles, tools.preQualify)));

program
	.command("enrich")
	.argument("<profiles...>", "one or more profile URLs or bare publicIds (pre-qualify survivors)")
	.description("Fetch the rest of the profile (card + activity, not experience) into the Person; Lead → To qualify. Batched (≤4 parallel reduck runs).")
	.action(async (profiles) => out(await batch(profiles, tools.enrich)));

program
	.command("qualify")
	.argument("<profiles...>", "one or more profile URLs or bare publicIds (must be enriched)")
	.option("--show", "print the judgment context (contract + frozen evidence); writes nothing")
	.description("Judge each person against the soft ICP (LLM); Lead moves to the human gate. Batched (≤4 in flight).")
	.action(async (profiles, { show }) => {
		if (show) return out(await batch(profiles, tools.context));
		out(await batch(profiles, tools.qualify));
	});

program
	.command("check-lead-stages")
	.argument("<status>", `a Lead Status, e.g. "To pre-qualify" or "To qualify"`)
	.description("Follow-up worklist: everyone whose Lead is at <status> — name + LinkedIn URL to pipe into the next stage.")
	.action(async (status) => out(await tools.checkLeadStages(status)));

program
	.command("list")
	.description("Decisions awaiting a human verdict (the review queue): id, name, kind, app link.")
	.action(async () => out(await tools.list()));

program
	.command("show")
	.argument("<decision>", "Decision id, Notion URL, or app URL")
	.description("One decision by id: the judge's judgment (output, statements, evidence), plus the human diff once reviewed.")
	.action(async (decision) => out(await tools.show(decision)));

program.parseAsync().catch((e: unknown) => {
	console.error(renderError(e));
	process.exit(1);
});
