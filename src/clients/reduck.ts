// Runner — the one bit of plumbing, and the ONLY file that knows both the Reduck client and this
// repo. The client itself is portable (reduck.client.ts: no env, no logger, no gate); this binds it
// to salesflock's three local facts and nothing more:
//   the credential   REDUCK_API_KEY, absent ⇒ loud. There is no fallback, deliberately: the review
//                    app is a serverless function, and the old client silently shelled a CLI that
//                    does not exist there — a missing key then reported "Session expired" instead of
//                    "no credential", which is a whole afternoon to diagnose and one line to prevent.
//   the ceiling      one request = one slot of gate(REDUCK_CONCURRENCY). A batch is one request, so
//                    fanning out through `runAll` costs one slot rather than one per script.
//   the trace        log() before and after each request, so a hung run is a dangling start line.
// A script's contract (args, output) lives in the script — `reduck read reduck/<host>/<slug>` —
// never restated here.

import { createReduckClient, type Args, type Call, type Contract, type RunOpts } from "./reduck.client.js";
import { gate, REDUCK_CONCURRENCY } from "../concurrency.js";
import { log } from "../log.js";

export type { Args, Call, Contract, RunOpts, Target, ManagedRegion } from "./reduck.client.js";
export { ReduckError } from "./reduck.client.js";

const MCP_URL = process.env.REDUCK_MCP_URL ?? "https://mcp.reduck.ai";

// Read at CALL time, never at import: the review app injects its env per process, and a module-level
// read would freeze whatever was set when the bundle loaded.
const apiKey = (): string => {
	const key = process.env.REDUCK_API_KEY;
	if (!key)
		throw new Error(
			"no REDUCK_API_KEY — every run goes over the Reduck REST API (mcp.reduck.ai), which needs one. " +
				"Create it at https://reduck.ai/api-keys and put it in the environment of THIS process."
		);
	return key;
};

const client = () => createReduckClient({ credential: { apiKey: apiKey() }, baseUrl: MCP_URL });

// The single ceiling on concurrent requests to the run door. One `runAll` — however many scripts it
// carries — is one slot, because it is one request; the server meters the browsers behind it and
// queues the rest FIFO.
const slot = gate(REDUCK_CONCURRENCY);

// WHERE this went, in the trace — because "which browser ran it" is the question a wrong result
// raises first, and it was unanswerable after the fact: a scrape on the wrong identity and a scrape
// on the cloud read identically in the log. Short by design (`@cloud/FR`, `@device:c12b4b27`), so it
// costs a few characters on a line that already carries the args.
const where = (opts?: RunOpts): string => {
	const t = opts?.target ?? "extension";
	const at = typeof t === "string" ? t : `device:${t.deviceId.slice(0, 8)}`;
	return ` @${at}${opts?.country ? `/${opts.country}` : ""}${opts?.region ? `/${opts.region}` : ""}`;
};

const label = (calls: Call[], opts?: RunOpts): string =>
	calls.map((c) => `${c.addr} ${Object.entries(c.args ?? {}).map(([k, v]) => `${k}=${v}`).join(" ")}`.trim()).join(" | ") +
	where(opts);

// Log at the START — so a slow or hung run is visible immediately, not only once it returns — then
// again on completion with the elapsed. The args and the target self-tag both lines, so concurrent
// requests stay paired across the interleaved output.
const traced = <T>(calls: Call[], opts: RunOpts | undefined, fn: () => Promise<T>): Promise<T> =>
	slot(async () => {
		const what = label(calls, opts);
		log("reduck", `${what} …`);
		const t0 = Date.now();
		try {
			return await fn();
		} finally {
			log("reduck", `${what} → done (${Date.now() - t0}ms)`);
		}
	});

// runAll(calls, opts) — several scripts in ONE request, each on its own browser, one outcome each:
// a rejection never removes its siblings' results. The batch is the point — a watchlist scan is one
// request and one poll instead of one per community.
export const runAll = <T = unknown>(
	calls: Call[],
	opts?: RunOpts
): Promise<PromiseSettledResult<T>[]> => traced(calls, opts, () => client().runAll<T>(calls, opts));

// run(addr, args, opts) — one script, unwrapped. `opts.target` is WHICH browser, i.e. which
// signed-in identity the site sees: core carries it and never chooses it, because only the caller
// knows whether this run reads or writes (see agents/reddit-engage/config.ts TARGETS).
export const run = <T = unknown>(addr: string, args: Args = {}, opts?: RunOpts): Promise<T> =>
	traced([{ addr, args }], opts, () => client().run<T>(addr, args, opts));

// read(addr) — a script's contract, the ground truth `sflock bind` compiles into TS types.
export const read = (addr: string): Promise<Contract> => client().read(addr);

// devices() — the paired browsers, and the one call that does NOT go through the REST door: it has
// no devices endpoint, so this is the MCP door's `list_devices` tool over the same URL and the same
// key. It answers the server's own TEXT, for a human to read — never something to branch on. It
// lives in the binding rather than in the client for exactly that reason: the client is a typed REST
// surface, this is operator tooling (`sflock devices`), and a device id is what `DEVICES` pins.
export const devices = async (): Promise<string> => {
	const res = await fetch(MCP_URL, {
		method: "POST",
		headers: {
			"X-API-Key": apiKey(),
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream"
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "list_devices", arguments: {} }
		})
	});
	const text = await res.text();
	// The MCP door answers either JSON or a one-event SSE stream; both carry the same JSON-RPC body.
	const json = text.startsWith("event:") ? text.slice(text.indexOf("data:") + 5).trim() : text;
	const body = JSON.parse(json) as {
		result?: { content?: { text?: string }[] };
		error?: { message?: string };
	};
	if (body.error) throw new Error(`reduck list_devices: ${body.error.message ?? JSON.stringify(body.error)}`);
	return body.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
};
