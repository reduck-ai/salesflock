#!/usr/bin/env node
// The tools, exposed as CLI subcommands — JSON on stdout so the agent reads each
// result. Only composite tools live here; single base scripts the agent runs with
// `reduck run reduck/<host>/<slug>` directly (the contract is `reduck read`able).

import "../../src/env.js";
import { Command } from "commander";
import { renderError } from "../../src/errors.js";
import { tools } from "./tools.js";

const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

const program = new Command()
	.name("leads")
	.description("LinkedIn lead-gen tools that compose reduck scripts and persist to your CRM.");

program
	.command("search")
	.argument(
		"<query>",
		`Google query, e.g. site:www.linkedin.com/in "senior product manager" "UiPath"`
	)
	.option("--n <count>", "max result cards", parseInt)
	.description(
		"Discover profiles via Google (one run); write Person stubs + Sourcing provenance + new Leads (To enrich)."
	)
	.action(async (query, { n }) => out(await tools.search(query, n)));

program
	.command("enrich")
	.argument("<profile>", "profile URL or bare publicId")
	.description(
		"Profile + experience (three runs) assembled into the Person; their Lead moves to To qualify."
	)
	.action(async (profile) => out(await tools.enrich(profile)));

program
	.command("qualify")
	.argument("<profile>", "profile URL or bare publicId (must be enriched)")
	.option("--show", "print the judgment context (contract + frozen evidence); writes nothing")
	.description("Judge the person against the ICP (LLM); Lead moves to the human gate.")
	.action(async (profile, { show }) => {
		if (show) return out(await tools.context("qualify", profile));
		out(await tools.qualify(profile));
	});

program
	.command("engage")
	.argument("<profile>", "profile URL or bare publicId (must be enriched)")
	.option(
		"--depends-on <decisionId...>",
		"upstream Decision id(s) — e.g. the qualification this engagement is conditioned on; held back until they are Accepted"
	)
	.option("--show", "print the judgment context (contract + frozen evidence); writes nothing")
	.description("Draft how to open the relationship (comment or invite) as its own Decision; standalone, or gated behind --depends-on.")
	.action(async (profile, { show, dependsOn }) => {
		if (show) return out(await tools.context("engage", profile));
		out(await tools.engage(profile, { dependsOn }));
	});

// Reviewing Decisions (list/show) is agent-agnostic — `sflock decisions --agent linkedin-leads`.

program
	.command("get-company")
	.argument("<company>", "company LinkedIn URL or bare slug")
	.description("LinkedIn company info (one run), written to Notion (idempotent on LinkedIn URL).")
	.action(async (company) => out(await tools.getCompany(company)));

program
	.command("put-lead")
	.description(
		"Set up a Lead (a person; Name derived from them) from ids the get-* tools returned."
	)
	.requiredOption("--person <id>", "the Person's Notion page id (get-profile)")
	.option("--company <id>", "the Company's Notion page id (get-company), when known")
	.action(async ({ person, company }) =>
		out(await tools.putLead({ personId: person, companyId: company }))
	);

program.parseAsync().catch((e: unknown) => {
	console.error(renderError(e));
	process.exit(1);
});
