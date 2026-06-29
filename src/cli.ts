#!/usr/bin/env node
// The tools, exposed as CLI subcommands — one per tool, JSON on stdout so the
// agent (driven by CLAUDE.md) can read each result.

import { Command } from "commander";
import { tools } from "./tools.js";
import { run } from "./run.js";
import { makeAdapter } from "./adapter.js";

const t = tools(run, makeAdapter());
const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

const program = new Command()
	.name("leads")
	.description("LinkedIn lead-gen tools — reduck scripts wrapped with your record store.");

program
	.command("discover")
	.argument("<topic>")
	.option("--limit <n>", "max results", "20")
	.action(async (topic, o) => out(await t.discover(topic, +o.limit)));

program
	.command("post")
	.argument("<postUrl>")
	.action(async (url) => out(await t.post(url)));

program
	.command("reactors")
	.argument("<postUrl>")
	.option("--limit <n>", "max results", "50")
	.action(async (url, o) => out(await t.reactors(url, +o.limit)));

program
	.command("get-profile")
	.argument("<profileUrl>")
	.description("Profile + experience + education + company; writes the lead to your store.")
	.action(async (url) => out(await t.getProfile(url)));

program.parseAsync();
