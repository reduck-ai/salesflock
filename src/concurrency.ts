// Bounded work. ONE RULE: a backend is bounded INSIDE the client that does its I/O, on the quantity
// that backend actually limits — a COUNT (`gate`) or a RATE (`pace`). Nothing generic bounds anything.
//   the browser device — a count, REDUCK_CONCURRENCY (clients/reduck.ts). Physical: you have so many.
//   the Notion API     — a rate, NOTION_RPS (stores/notion.ts). ~3 rps per connection plus a
//                        workspace-wide limit shared with the review app, so no local measurement can
//                        justify a number; `pace` adapts from Notion's own 429s. It needs no
//                        concurrency knob: `pace` reserves an instant per caller before it awaits, so
//                        spacing is a property of the clock, not of how many callers queued — a wider
//                        fan-out parks more callers, it cannot raise the rate.
//   the LLM provider   — NOT bounded here, and ai/llm.ts says why: its failure mode is a silent
//                        stall rather than a refusal, so no width can see it and a deadline can.
//
// So `mapLimit` fans out UNBOUNDED unless a caller passes a limit. There used to be a
// TASK_CONCURRENCY of 8, equal to the LLM gate — so it clamped first and raising the gate did
// nothing. A default that silently becomes the real limit is worse than none: the caller never made
// the decision, and the knob lied about what it controlled (8-wide: 75s on a corpus that runs in 22s).

import { renderError } from "./errors.js";
import { log } from "./log.js";

export const REDUCK_CONCURRENCY = Number(process.env.REDUCK_CONCURRENCY) || 4;
export const NOTION_RPS = Number(process.env.NOTION_RPS) || 2.5;

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

// mapLimit(items, fn, opts) — map `fn` over `items`, results in input order. UNBOUNDED by default:
// the backend gates and pacers beneath it are the real ceilings, each sitting in the client that owns
// the scarcity, so a generic width here would only ever shadow them (it did — see the header).
// `opts.limit` exists for the caller that has a reason of its own, and a caller with no such reason
// should not invent one.
//
// `opts.label` turns the fan-out into a PROGRESS line: `m/n <label>` on each completion. It belongs
// here and nowhere else, because `n` exists here and nowhere else — a backend seam logs the call it
// is making and cannot know how many more are coming, so "how far along" is only answerable by the
// thing holding the list. The two seams are complementary, not redundant: this one says how much is
// left, the write's own start/done line (stores/notion.ts `traced`) says which row is stuck when the
// counter stops moving. Unlabelled ⇒ silent, so a fan-out that is not worth watching costs nothing.
export const mapLimit = async <T, R>(
	items: T[],
	fn: (item: T, index: number) => Promise<R>,
	{ limit, label }: { limit?: number; label?: string } = {}
): Promise<R[]> => {
	const out: R[] = new Array(items.length);
	let next = 0;
	let done = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i], i);
			// Counted on COMPLETION, never on dispatch: `limit` items are in flight at any moment, so a
			// counter that ticked when work started would run ahead of what has actually landed — and
			// with the store as the record, what landed is the only thing the number can honestly mean.
			if (label) log("batch", `${++done}/${items.length} ${label}`);
		}
	};
	// No limit ⇒ one worker per item, i.e. everything in flight at once. `Math.min` with an absent
	// limit would be NaN, and `Array.from({length: NaN})` is empty — zero workers, a silent hang.
	await Promise.all(Array.from({ length: Math.min(limit ?? items.length, items.length) }, worker));
	return out;
};

// batch(items, fn) — the resilient fan-out every per-item CLI command shares: one item's failure
// becomes an `{item, error}` entry (via the single renderError) instead of aborting the run, so a
// batch never loses its good results to one bad item. The error still reaches the shell — a non-zero
// exit flags that something failed, so a run is never silently "successful" while an item errored.
export const batch = async <T, R>(
	items: T[],
	fn: (item: T) => Promise<R>,
	label?: string
): Promise<(R | { item: T; error: string })[]> => {
	const results = await mapLimit(
		items,
		(item) => fn(item).catch((e: unknown) => ({ item, error: renderError(e) })),
		{ label }
	);
	if (results.some((r) => r && typeof r === "object" && "error" in r)) process.exitCode = 1;
	return results;
};
