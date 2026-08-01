// Bounded work — where "how many at once, and how often" is decided. Each scarce backend is bounded
// on the quantity IT actually limits (conflating them throttles fast calls to the slowest backend's
// ceiling, and bounding the wrong quantity doesn't bound anything at all):
//   REDUCK_CONCURRENCY — the single browser device (the reduck runner's gate). Physical: how many.
//   NOTION_RPS         — the Notion API (the store's pacer). A RATE, because that is what Notion
//                        limits: ~3 requests/second per connection *on average*, plus a second
//                        workspace-wide limit shared with every other connection (the review app
//                        included). So no local measurement can justify a concurrency number — the
//                        workspace limit is invisible from inside one process, and a burst that
//                        "drew zero 429s" one evening earns a 631s ban the next. The default sits
//                        UNDER the documented average, because an average sustained exactly has no
//                        margin (measured: 3 rps still drew a 429), and `pace` adapts from there.
//                        There is deliberately NO Notion concurrency knob: at this rate with
//                        sub-second calls, in-flight count is 1–3 by construction.
//   LLM_CONCURRENCY    — the model provider (llm.ts's gate). Providers throttle wide fan-outs
//                        (Bedrock 429s at even 2 concurrent on some accounts — measured, not assumed).
//   TASK_CONCURRENCY   — a tool's fan-out over a list (mapLimit's default).
// A tool fans a list out wide; each underlying call still acquires its backend's gate or pacer, so
// browser, Notion and LLM work progress concurrently instead of serializing inside one narrow wave.

import { renderError } from "./errors.js";

export const REDUCK_CONCURRENCY = Number(process.env.REDUCK_CONCURRENCY) || 4;
export const NOTION_RPS = Number(process.env.NOTION_RPS) || 2.5;
export const LLM_CONCURRENCY = Number(process.env.LLM_CONCURRENCY) || 8;
export const TASK_CONCURRENCY = Number(process.env.TASK_CONCURRENCY) || 8;

// gate(limit) — a FIFO admission gate: at most `limit` thunks run at once, the rest queue. Returns
// the acquire wrapper; ONE gate instance shared by all callers is a single ceiling for that backend.
export const gate = (limit: number) => {
	let active = 0;
	const queue: (() => void)[] = [];
	return async <T>(fn: () => Promise<T>): Promise<T> => {
		if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
		active++;
		try {
			return await fn();
		} finally {
			active--;
			queue.shift()?.();
		}
	};
};

// pace(rps) — `gate`'s sibling for a RATE-limited backend, same shape (an acquire wrapper), one
// question: when may the next request START? Two things answer it and both are one instant —
//   the floor WE choose:      no sooner than 1000/rps after the previous start;
//   the ceiling IT announces: `hold(ms)` — the backend's own Retry-After.
// So the counter becomes a clock, and a caller's private retry sleep becomes this clock's shared
// state: `hold` parks every caller at once, in flight and future, which is the single queue a
// rate-limited API asks for. Without it each caller discovers the same ban separately, burns its own
// attempts on it, and fails alone — the exact way a 631s ban cost a 417-row batch 377 of its rows.
// `rps` is a CEILING, not a target. The documented limit is an *average*, so sustaining exactly it
// leaves no margin for jitter — measured: paced at the documented 3 rps, a run still drew one
// `public_api_request_rate_limit` after ~8 minutes. So the clock adapts: a `hold` halves the rate,
// and clean requests ease it back toward the ceiling. The backend's own 429s calibrate it, which is
// the only honest source — the real capacity depends on the workspace's plan and on who else is
// talking to it, neither of which is knowable from in here.
export const pace = (rps: number) => {
	const floor = 1000 / rps; // the fastest spacing allowed
	const CEILING = floor * 8; // the slowest we back off to (a workspace-wide squeeze)
	const EASE = 0.02; // fraction of `floor` recovered per clean start (~50 calls back to full rate)
	let interval = floor;
	let next = 0; // the instant the next request may start (max of the pace floor and any hold)
	let until = 0; // nothing starts before this — set by hold()
	const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
	const slot = async <T>(fn: () => Promise<T>): Promise<T> => {
		for (;;) {
			// Reserve an instant, so concurrent callers queue behind each other rather than all
			// reading the same "now" and starting together.
			const at = Math.max(Date.now(), next, until);
			next = at + interval;
			if (at > Date.now()) await sleep(at - Date.now());
			if (Date.now() < until) continue; // a hold arrived while we waited — re-reserve behind it
			interval = Math.max(floor, interval - floor * EASE); // clean start ⇒ creep back up
			return fn();
		}
	};
	return Object.assign(slot, {
		hold: (ms: number): void => {
			until = Math.max(until, Date.now() + ms);
			interval = Math.min(CEILING, interval * 2); // and go slower than we were
		},
		// The rate the clock has settled on — for the log line that reports a park, so the operator
		// sees what it backed off TO, not just that it backed off.
		rps: (): number => 1000 / interval
	});
};

// mapLimit(items, fn, limit) — map `fn` over `items` with at most `limit` in flight (default the tool
// fan-out), results in input order. The backend gates beneath it are the hard floors for slow work.
export const mapLimit = async <T, R>(
	items: T[],
	fn: (item: T, index: number) => Promise<R>,
	limit = TASK_CONCURRENCY
): Promise<R[]> => {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
};

// batch(items, fn) — the resilient fan-out every per-item CLI command shares: one item's failure
// becomes an `{item, error}` entry (via the single renderError) instead of aborting the run, so a
// batch never loses its good results to one bad item. The error still reaches the shell — a non-zero
// exit flags that something failed, so a run is never silently "successful" while an item errored.
export const batch = async <T, R>(
	items: T[],
	fn: (item: T) => Promise<R>
): Promise<(R | { item: T; error: string })[]> => {
	const results = await mapLimit(items, (item) => fn(item).catch((e: unknown) => ({ item, error: renderError(e) })));
	if (results.some((r) => r && typeof r === "object" && "error" in r)) process.exitCode = 1;
	return results;
};
