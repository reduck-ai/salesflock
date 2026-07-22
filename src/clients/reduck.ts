// Runner — the one bit of plumbing. Shells the bundled reduck CLI and returns its
// JSON result, reusing the user's device, auth and cookies. Self-contained: the CLI
// is a dependency, resolved from node_modules (no global install). REDUCK_BIN
// overrides — e.g. a patched local build. The script's contract (args, output)
// lives in the script — `reduck read reduck/<host>/<slug>` — never restated here.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { gate } from "../concurrency.js";
import { log } from "../log.js";

const exec = promisify(execFile);

// The single global ceiling on concurrent reduck runs (one browser device). Every `run` acquires a
// slot, so any fan-out — a profile's parallel scripts, a batched tool — is throttled to the limit.
const slot = gate();
const require = createRequire(import.meta.url);

// The bundled CLI's entry, run under this same node. Falls back to a `reduck` on
// PATH if the dependency can't be resolved.
function reduckArgv(): string[] {
	if (process.env.REDUCK_BIN) return [process.env.REDUCK_BIN];
	try {
		const pkg = require.resolve("@reduck-ai/cli/package.json");
		const { bin } = require(pkg) as { bin: string | Record<string, string> };
		return [process.execPath, join(dirname(pkg), typeof bin === "string" ? bin : bin.reduck)];
	} catch {
		return ["reduck"];
	}
}

export type Args = Record<string, string | number | boolean>;

export const run = <T = unknown>(addr: string, args: Args): Promise<T> =>
	slot(async () => {
		const pairs = Object.entries(args).map(([k, v]) => `${k}=${v}`);
		const [cmd, ...pre] = reduckArgv();
		const t0 = Date.now();
		// `reduck run` prints the result as JSON on stdout, the run id + errors on stderr. Surface the
		// run id — the handle into `read_run_trace` — with the elapsed; args self-tag concurrent runs.
		const { stdout, stderr } = await exec(cmd, [...pre, "run", "--script", addr, ...pairs]);
		const runId = stderr.match(/run_id:\s*(\S+)/)?.[1] ?? "?";
		log("reduck", `${addr} ${pairs.join(" ")} → ${runId} (${Date.now() - t0}ms)`);
		return JSON.parse(stdout) as T;
	});

// A script's contract — the ground truth. input/output are JSON Schemas (server-enforced
// on every run); `bind` compiles `output` into a TS type.
export interface Contract {
	name: string;
	input: object;
	output: object;
}

// read(addr) — fetch a script's contract. `reduck read` prints YAML (no --json) with a
// trailing "Success rate…" footer that isn't YAML; strip it before parsing. Swap the
// strip for --json once the CLI grows it.
export const read = async (addr: string): Promise<Contract> => {
	const [cmd, ...pre] = reduckArgv();
	const { stdout } = await exec(cmd, [...pre, "read", addr]);
	const footer = stdout.search(/^Success rate/m);
	return parse(footer < 0 ? stdout : stdout.slice(0, footer)) as Contract;
};
