#!/usr/bin/env node
// The funnel tools as CLI subcommands — JSON on stdout so the agent reads each result. The clean
// four stages: search → pre-qualify → enrich → qualify, plus list/show for the review queue.

import "../../src/env.js";
import { Command } from "commander";
import { renderError } from "../../src/errors.js";
import { tools } from "./tools.js";

const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

const program = new Command()
	.name("rpa")
	.description("Former-RPA-PM lead-gen: search → pre-qualify (deterministic) → enrich → qualify.");

program
	.command("search")
	.argument("<query>", `Google query, e.g. site:www.linkedin.com/in Ex-UiPath senior product manager`)
	.option("--n <count>", "max result cards", parseInt)
	.description("Discover profiles via Google (one run); write Person stubs + Sourcing + new Leads (To pre-qualify).")
	.action(async (query, { n }) => out(await tools.search(query, n)));

program
	.command("pre-qualify")
	.argument("<profile>", "profile URL or bare publicId")
	.description("Deterministic gate: experience-only pull → was a senior PM at an RPA vendor and has left? Lead → To enrich | Not qualified.")
	.action(async (profile) => out(await tools.preQualify(profile)));

program
	.command("enrich")
	.argument("<profile>", "profile URL or bare publicId (a pre-qualify survivor)")
	.description("Fetch the rest of the profile (card + activity, not experience) into the Person; Lead → To qualify.")
	.action(async (profile) => out(await tools.enrich(profile)));

program
	.command("qualify")
	.argument("<profile>", "profile URL or bare publicId (must be enriched)")
	.option("--show", "print the judgment context (contract + frozen evidence); writes nothing")
	.description("Judge the person against the soft ICP (LLM); Lead moves to the human gate.")
	.action(async (profile, { show }) => {
		if (show) return out(await tools.context(profile));
		out(await tools.qualify(profile));
	});

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
