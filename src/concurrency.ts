// Bounded concurrency — where "how many at once" is decided. Three DISTINCT scarce backends, three
// limits (conflating them under one number throttles fast API calls to the slowest backend's ceiling):
//   REDUCK_CONCURRENCY — the single browser device (the reduck runner's gate). Physical.
//   NOTION_CONCURRENCY — the Notion API (the store's gate). Near its rate limit.
//   TASK_CONCURRENCY   — a tool's fan-out over a list (mapLimit's default), and thus the effective
//                        LLM concurrency (Bedrock tolerates it, so it needs no gate of its own).
// A tool fans a list out wide; each underlying call still acquires its backend's gate, so browser,
// Notion and LLM work progress concurrently instead of serializing inside one narrow wave.

import { renderError } from "./errors.js";

export const REDUCK_CONCURRENCY = Number(process.env.REDUCK_CONCURRENCY) || 4;
export const NOTION_CONCURRENCY = Number(process.env.NOTION_CONCURRENCY) || 4;
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
