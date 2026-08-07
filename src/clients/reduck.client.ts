// The Reduck REST client — start runs on a browser, read a script's contract. Nothing else.
//
// PORTABLE BY CONSTRUCTION: no env, no logger, no concurrency gate, no import from this repo. Every
// dependency arrives as an argument, so this file can be lifted into the Reduck offering unchanged
// and the binding beside it (reduck.ts) is the only thing that knows salesflock exists. Same split
// as stores/notion.codec.ts (portable) beside stores/notion.ts (bound).
//
// ONE DOOR: `POST /run` on the MCP server's REST API. The CLI is not a second way to do this — it
// publishes no library entry (bin only) and speaks the MCP protocol, not REST; the app's SDK covers
// the app API and has no /run at all. So this is the one client, and there is no transport to choose.
//
// ONE REQUEST SHAPE: every call sends `scripts: [...]`, even for a single script (the server accepts
// one), so there is exactly one response to handle — an array of outcomes, or a 202 batch to poll.
// `run` is `runAll` of one. The alternative was two request shapes and two response shapes for the
// same act, which is where the divergence between a single call and a fan-out would live.
//
// ONE OUTCOME PER ENTRY, as PromiseSettledResult — the platform's own vocabulary for exactly what
// the server returns: parallel scripts are independent, so one failing never removes its siblings'
// results. A new noun here would only re-say `{status:"fulfilled"|"rejected"}`.

// A script's arguments, as the wire takes them.
export type Args = Record<string, string | number | boolean>;

// WHO we are to the server. Two headers, one meaning — mirrors the app SDK's own credential union
// (integrations/ts/sdk/src/client.ts) and the server's `credentialFromReq`.
export type Credential = { apiKey: string } | { oauthToken: string };

// WHERE a run executes. The server's own vocabulary, minus the one member this client has no use
// for (`"local"`, a paired `reduck local` device):
//   "cloud"        a Reduck-hosted browser — signed out, and the only target that takes region/country.
//                  (The server's stored label for it is "managed"; "cloud" is what the wire says.)
//   "extension"    the caller's paired browser — already signed in, so a loggedIn script needs no vault.
//                  Auto-picks ONLY when exactly one extension device is paired; 0 or several is a
//                  refusal from the server that lists the ids, which is why the next form exists.
//   {deviceId}     one exact paired browser. A device IS an identity: which account the site sees is
//                  whichever one that browser is signed into, and nothing here can check it.
export type Target = "cloud" | "extension" | { deviceId: string };

export type ManagedRegion = "eu-central-1" | "us-east-1" | "us-west-2" | "ap-southeast-1";

// How a run is configured — never WHAT it runs (that is `Call`). The two levels share no key, so an
// argument can never be attached to the run instead of to the script that uses it.
export interface RunOpts {
	// Omitted ⇒ "extension". The REST door's own default is the CLOUD, which is signed out: a caller
	// that forgot to say where would spend a cloud browser to fail unauthenticated. Defaulting to the
	// caller's own browser makes the silent case the safe one; the cloud is then always deliberate.
	target?: Target;
	region?: ManagedRegion; // cloud only — the server refuses it on a device
	country?: string; // cloud only — ISO-3166 alpha-2 residential egress
	// Turn a `runAll` list into a CHAIN: one browser, in order, each script seeing the previous one's
	// cookies and DOM (never its return value). Stops at the first failure; the rest report that they
	// never ran, so the outcome list still has one entry per call.
	sequential?: boolean;
	// Seconds the server holds the request before handing back a pollable batch (default 60, max 110
	// there). Leave it unset — the poll below makes the difference invisible either way.
	waitForSeconds?: number;
}

// WHAT to run: a script address `[<owner>/]<host>/<slug>` and the arguments it takes.
export interface Call {
	addr: string;
	args?: Args;
}

// A script's contract — the ground truth for its arguments and its output. `input`/`output` are JSON
// Schemas the server enforces on every run.
export interface Contract {
	name: string;
	description?: string;
	loggedIn?: boolean;
	sideEffects?: string;
	input: object;
	output: object;
}

// Every failure this client raises, with what the server said about it. `runId` is the handle into
// the trace, so a caller (a reviewer's card, a CLI's exit code) can point at the run that failed
// rather than only at the sentence.
export class ReduckError extends Error {
	constructor(
		message: string,
		readonly info: { runId?: string; errorType?: string; status?: number } = {}
	) {
		super(message);
		this.name = "ReduckError";
	}
}

// `[<owner>/]<host>/<slug>` → the step the API takes. The OWNER is carried, never dropped: a script
// is its address, not its name, so a same-named copy under a different owner is a different script
// with its own contract. Dropping it silently resolves against the caller's own scripts instead.
const addrParts = (addr: string): { handle?: string; host: string; slug: string } => {
	const m = addr.match(/^(?:(@?[^/]+)\/)?([^/]+)\/([^/]+)$/);
	if (!m) throw new ReduckError(`not a script address: ${addr}`);
	return { ...(m[1] ? { handle: m[1] } : {}), host: m[2], slug: m[3] };
};

// The server's per-run envelope: a terminal run carries `result` or `error`, one still in flight
// carries the handle and how long to wait (mcp-server runs/envelope.ts).
interface Envelope {
	status?: "queued" | "running" | "completed" | "failed";
	runId?: string;
	result?: unknown;
	error?: string;
	errorType?: string;
	externalMessage?: string;
	retryAfterMs?: number;
}
interface Batch {
	batchId: string;
	status: "queued" | "running" | "completed" | "failed";
	runs: Envelope[];
	retryAfterMs?: number;
}

const MAX_PARALLEL = 20; // the server's own cap on one request's fan-out (browser.ts)
const pending = (e: { status?: string }): boolean => e.status === "queued" || e.status === "running";

const chunks = <T>(items: T[], size: number): T[][] =>
	Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
		items.slice(i * size, i * size + size)
	);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ReduckClient {
	runAll<T = unknown>(calls: Call[], opts?: RunOpts): Promise<PromiseSettledResult<T>[]>;
	run<T = unknown>(addr: string, args?: Args, opts?: RunOpts): Promise<T>;
	read(addr: string): Promise<Contract>;
}

export const createReduckClient = ({
	credential,
	baseUrl = "https://mcp.reduck.ai",
	fetch: doFetch = globalThis.fetch
}: {
	credential: Credential;
	baseUrl?: string;
	fetch?: typeof globalThis.fetch;
}): ReduckClient => {
	const root = baseUrl.replace(/\/+$/, "");
	const auth: Record<string, string> =
		"apiKey" in credential
			? { "X-API-Key": credential.apiKey.trim() }
			: { Authorization: `Bearer ${credential.oauthToken.trim()}` };

	const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
		const res = await doFetch(`${root}${path}`, {
			...init,
			headers: { ...auth, "Content-Type": "application/json", ...init?.headers }
		});
		const body = (await res.json().catch(() => ({}))) as T & { error?: string };
		// 202 is not a failure: it is "still running, here is the handle" — the one status where the
		// body is the answer rather than the complaint.
		if (!res.ok && res.status !== 202)
			throw new ReduckError(`reduck ${res.status} ${path}: ${body.error ?? JSON.stringify(body)}`, {
				status: res.status
			});
		return body;
	};

	// One envelope → one settled outcome. The three cases are the three things a terminal run can be,
	// and the third is the one worth having code for: a run that ended with NEITHER a result nor an
	// error. Measured — a device signed OUT of the site came back exactly that way, and passing the
	// `undefined` on made the caller crash a frame later on a property of nothing, naming a field
	// instead of the browser. An empty answer that was never an answer is refused here, where the run
	// id is still in hand. (`null` is a real result; only absence is not.)
	const settle = <T>(env: Envelope, call: Call): PromiseSettledResult<T> => {
		const at = `${call.addr}${env.runId ? ` (run ${env.runId})` : ""}`;
		if (env.error !== undefined)
			return {
				status: "rejected",
				reason: new ReduckError(`reduck ${at}: ${env.externalMessage ?? env.error}`, {
					runId: env.runId,
					errorType: env.errorType
				})
			};
		if (env.result === undefined)
			return {
				status: "rejected",
				reason: new ReduckError(
					`reduck ${at}: ended "${env.status ?? "?"}" with no result — read its trace (is the device signed in?)`,
					{ runId: env.runId }
				)
			};
		return { status: "fulfilled", value: env.result as T };
	};

	// One request's worth of scripts (≤ the server's cap), run to a terminal state. A 200 already
	// carries the outcomes; a 202 carries a batch handle, and polling it is what makes "await the run"
	// true for the caller whatever the server decided about holding the request open.
	const runChunk = async <T>(calls: Call[], opts: RunOpts): Promise<PromiseSettledResult<T>[]> => {
		const answer = await api<Envelope[] | Batch>("/run", {
			method: "POST",
			body: JSON.stringify({
				scripts: calls.map((c) => ({ ...addrParts(c.addr), args: c.args ?? {} })),
				browser: opts.target ?? "extension",
				...(opts.region ? { region: opts.region } : {}),
				...(opts.country ? { country: opts.country } : {}),
				...(opts.sequential ? { sequential: true } : {}),
				...(opts.waitForSeconds !== undefined ? { waitForSeconds: opts.waitForSeconds } : {})
			})
		});
		let envelopes: Envelope[];
		if (Array.isArray(answer)) envelopes = answer;
		else {
			let batch = answer;
			while (pending(batch)) {
				await sleep(batch.retryAfterMs ?? 2000);
				batch = await api<Batch>(`/batches/${batch.batchId}`);
			}
			envelopes = batch.runs;
		}
		// One outcome per call, always — the server promises it, and a caller reading results by index
		// must not have to wonder. A short list would otherwise silently re-pair results with calls.
		if (envelopes.length !== calls.length)
			throw new ReduckError(
				`reduck: asked for ${calls.length} script(s), the server answered for ${envelopes.length}`
			);
		return envelopes.map((e, i) => settle<T>(e, calls[i]));
	};

	const runAll = async <T>(calls: Call[], opts: RunOpts = {}): Promise<PromiseSettledResult<T>[]> =>
		calls.length
			? (await Promise.all(chunks(calls, MAX_PARALLEL).map((c) => runChunk<T>(c, opts)))).flat()
			: [];

	return {
		runAll,
		// The one-entry case, unwrapped: a single run has exactly one outcome, so a caller that asked
		// about one script gets a value or an exception rather than a list to destructure.
		run: async <T>(addr: string, args: Args = {}, opts: RunOpts = {}): Promise<T> => {
			const [outcome] = await runAll<T>([{ addr, args }], opts);
			if (outcome.status === "rejected") throw outcome.reason;
			return outcome.value;
		},
		read: async (addr: string): Promise<Contract> => {
			const { handle, host, slug } = addrParts(addr);
			const q = handle ? `?handle=${encodeURIComponent(handle.replace(/^@/, ""))}` : "";
			return api<Contract>(`/scripts/${encodeURIComponent(host)}/${encodeURIComponent(slug)}${q}`);
		}
	};
};
