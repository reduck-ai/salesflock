#!/usr/bin/env node
// sflock — the setup CLI. Populates an agent's schema with destination Ground Truth.
//   sflock pull --agent <id> --client <name> --model <m> [--model <m> …]
// writes agents/<id>/schema/<client>/<model>.json — the writable property set,
// enum options included.

import { Command } from "commander";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as hubspot from "./clients/hubspot.js";

// Client registry: name → the client that can describe a model. Only clients with a
// property surface belong here (reduck is a runner, not a schema source). Add one = add an entry.
const CLIENTS = { hubspot } as const;
type ClientName = keyof typeof CLIENTS;

// Project a property to what a writer needs, dropping the unwritable. What lands is
// exactly what the destination takes on write — enum values included (the bit the CLI couldn't give).
const project = (p: hubspot.Property) => ({
	name: p.name,
	label: p.label,
	type: p.type,
	fieldType: p.fieldType,
	...(p.options.length ? { options: p.options.map((o) => o.value) } : {})
});

const collect = (v: string, acc: string[]): string[] => [...acc, v];

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
			// readOnlyValue is the destination's own authoritative "can't write this".
			// Sort by name so the file is stable and `git diff` reads as a changelog.
			const rows = (await c.properties(m))
				.filter((p) => !p.modificationMetadata?.readOnlyValue)
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(project);
			const path = join(dir, `${m}.json`);
			await writeFile(path, JSON.stringify(rows, null, 2) + "\n");
			console.error(`${m}: ${rows.length} writable properties → ${path}`);
		}
	});

program.parseAsync();
