// Runner — the one bit of plumbing. Runs a reduck script and returns its JSON result, reusing the
// user's device, auth and cookies. The script's contract (args, output) lives in the script —
// `reduck read reduck/<host>/<slug>` — never restated here.
//
// TWO transports, ONE `run`. The CLI is the default: self-contained (a dependency resolved from
// node_modules, no global install), and REDUCK_BIN overrides it with e.g. a patched local build.
// But the review app is a serverless function — it has no node_modules to shell and no process to
// spawn — and a decision's `act` (stores/index.ts) has to reach a browser from exactly there. So
// REDUCK_API_KEY selects the HTTP transport: the same run, over the MCP server's REST surface.
//
// The seam is the point: every caller keeps calling `run(addr, args)` and none of them knows which
// transport answered. The HTTP one absorbs the one difference that would otherwise leak — a run
// slow enough to answer `202 {runId}` instead of a result — by polling `/runs/{id}` to a terminal
// state, because "await the run" is what the CLI's caller already means.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { gate, REDUCK_CONCURRENCY } from "../concurrency.js";
import { log } from "../log.js";

const exec = promisify(execFile);

// The single global ceiling on concurrent reduck runs (one browser device). Every `run` acquires a
// slot, so any fan-out — a profile's parallel scripts, a batched tool — is throttled to the limit.
const slot = gate(REDUCK_CONCURRENCY);
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

// The address `<owner>/<host>/<slug>` split into the script step the REST API takes. The OWNER is
// carried, not dropped: a script is its address, not its name (a same-named copy under a different
// owner is a different script), and host+slug alone resolves only against the caller's own scripts —
// so dropping it silently swaps which script runs, or 404s on the catalogue.
const addrParts = (addr: string): { handle?: string; host: string; slug: string } => {
	const m = addr.match(/^(?:(@?[^/]+)\/)?([^/]+)\/([^/]+)$/);
	if (!m) throw new Error(`not a script address: ${addr}`);
	return { ...(m[1] ? { handle: m[1] } : {}), host: m[2], slug: m[3] };
};

const MCP_URL = process.env.REDUCK_MCP_URL ?? "https://mcp.reduck.ai";

// The server's envelope, discriminated by `status` alone (mcp-server runs/envelope.ts): a terminal
// run carries `result` or `error`; one still in flight carries the handle and how long to wait.
interface Envelope {
	status: "completed" | "queued" | "running" | "failed";
	runId?: string;
	result?: unknown;
	error?: string;
	externalMessage?: string;
	retryAfterMs?: number;
}

// The HTTP transport. `POST /run` answers with the outcome, or 202 + a handle when the run outlives
// the request — so this polls `/runs/{id}` to a terminal state, honouring the server's own
// `retryAfterMs`, and hands back the same thing the CLI would. A failed run RAISES with the
// server's message: the error belongs to the caller (a reviewer's card, the CLI's exit code) and
// is never swallowed into a fake-empty success.
const runHttp = async <T>(addr: string, args: Args, key: string): Promise<T> => {
	const api = async (path: string, init?: RequestInit): Promise<Envelope> => {
		const res = await fetch(`${MCP_URL}${path}`, {
			...init,
			headers: { "X-API-Key": key, "Content-Type": "application/json", ...init?.headers }
		});
		const body = (await res.json()) as Envelope & { error?: string };
		if (!res.ok && res.status !== 202)
			throw new Error(`reduck ${res.status} ${path}: ${body.error ?? JSON.stringify(body)}`);
		return body;
	};
	// `browser: "extension"` — the user's own paired Chrome, which is what the CLI targets by default
	// and the only thing that works here: every script this agent runs is logged-in (and Reddit's
	// write scripts say so in their own contract, "runs only via the browser extension"). The hosted
	// cloud browser would be a different, signed-out identity.
	//
	// REDUCK_DEVICE_ID names WHICH paired browser when there are several — required then, because the
	// server refuses to guess (rightly: the browsers are different signed-in identities, so an
	// auto-pick would post as whoever happened to answer). Omit it with one device and it auto-picks.
	let env = await api("/run", {
		method: "POST",
		body: JSON.stringify({
			browser: "extension",
			...(process.env.REDUCK_DEVICE_ID ? { deviceId: process.env.REDUCK_DEVICE_ID } : {}),
			script: { ...addrParts(addr), args }
		})
	});
	while (env.status === "queued" || env.status === "running") {
		if (!env.runId) throw new Error(`reduck ${addr}: run is ${env.status} but the server gave no runId`);
		await new Promise((r) => setTimeout(r, env.retryAfterMs ?? 2000));
		env = await api(`/runs/${env.runId}`);
	}
	if (env.status === "failed") throw new Error(`reduck ${addr}: ${env.externalMessage ?? env.error}`);
	return env.result as T;
};

const runCli = async <T>(addr: string, args: Args, pairs: string[]): Promise<T> => {
	const [cmd, ...pre] = reduckArgv();
	// 64MB stdout headroom: a busy subreddit's week of full post bodies overflows Node's 1MB default.
	const { stdout, stderr } = await exec(cmd, [...pre, "run", "--script", addr, ...pairs], {
		maxBuffer: 64 * 1024 * 1024
	});
	const runId = stderr.match(/run_id:\s*(\S+)/)?.[1] ?? "?";
	log("reduck", `${addr} ${pairs.join(" ")} ← ${runId}`);
	return JSON.parse(stdout) as T;
};

export const run = <T = unknown>(addr: string, args: Args): Promise<T> =>
	slot(async () => {
		const pairs = Object.entries(args).map(([k, v]) => `${k}=${v}`);
		// Log at the START — so a slow or hung run is visible immediately, not only once it returns —
		// then again on completion with the elapsed. The args self-tag both lines, so concurrent runs
		// stay paired across the interleaved output.
		log("reduck", `${addr} ${pairs.join(" ")} …`);
		const t0 = Date.now();
		const key = process.env.REDUCK_API_KEY;
		const out = key
			? await runHttp<T>(addr, args, key)
			: await runCli<T>(addr, args, pairs);
		log("reduck", `${addr} ${pairs.join(" ")} → done (${Date.now() - t0}ms)`);
		return out;
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
