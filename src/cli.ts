#!/usr/bin/env node
// sflock — the setup CLI. Populates an agent's schema with destination Ground Truth.
//   sflock pull --agent <id> --client <name> --model <m> [--model <m> …]
// writes agents/<id>/schema/<model>.json — the model's writable contract.
//
// Each client describes a model as a JSON Schema (notion); a generic layer turns those
// into TS models. sflock is that generic layer's front: it asks the client to describe
// each model and writes the result verbatim — it holds no per-client semantics.

import { Command } from "commander";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as hubspot from "./clients/hubspot.js";
import * as notion from "./clients/notion.js";

// Client registry: name → the client that can describe a model. Only clients with a
// property surface belong here (reduck is a runner, not a schema source). Add one = add an entry.
const CLIENTS = { hubspot, notion } as const;
type ClientName = keyof typeof CLIENTS;

const collect = (v: string, acc: string[]): string[] => [...acc, v];

// Name the dump file by the schema's own title when the client gives one (notion's
// JSON Schema), else the model token (hubspot object types are already clean names).
const fileName = (model: string, described: unknown): string => {
	const title =
		described && typeof described === "object" && !Array.isArray(described)
			? (described as { title?: unknown }).title
			: undefined;
	return (typeof title === "string" ? title : model).replace(/[^\w.-]+/g, "_");
};

// Number of writable properties in a described model — a JSON Schema's `properties`, or
// a flat property array (hubspot, pending alignment) — for the progress line.
const propCount = (described: unknown): number =>
	Array.isArray(described)
		? described.length
		: Object.keys((described as { properties?: object }).properties ?? {}).length;

const program = new Command()
	.name("sflock")
	.description("Setup CLI — populate an agent's schema with destination Ground Truth.");

program
	.command("pull")
	.description("Dump each model's writable properties → agents/<agent>/schema/<client>/<model>.json")
	.requiredOption("--agent <id>", "agent under agents/ to populate")
	.requiredOption("--client <name>", `destination client (${Object.keys(CLIENTS).join(", ")})`)
	.requiredOption("--model <name>", "object type to pull (repeatable)", collect, [])
	.action(async ({ agent, client, model }: { agent: string; client: string; model: string[] }) => {
		const c = CLIENTS[client as ClientName];
		if (!c) program.error(`unknown client "${client}" — one of: ${Object.keys(CLIENTS).join(", ")}`);
		const agentDir = join("agents", agent);
		const ok = await stat(agentDir).then((s) => s.isDirectory()).catch(() => false);
		if (!ok) program.error(`no agent "${agent}" — ${agentDir}/ does not exist.`);
		const dir = join(agentDir, "schema");
		await mkdir(dir, { recursive: true });
		for (const m of model) {
			const described = await c.describe(m);
			const path = join(dir, `${fileName(m, described)}.json`);
			await writeFile(path, JSON.stringify(described, null, 2) + "\n");
			console.error(`${m}: ${propCount(described)} writable properties → ${path}`);
		}
	});

program.parseAsync();
