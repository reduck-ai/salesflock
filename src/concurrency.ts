// Bounded concurrency — the one place "how many at once" is decided. The device drives a single
// browser, so reduck runs are globally capped (the runner wraps every `run` in a shared `gate`);
// batch tools fan a list through the same limit with `mapLimit`. One number, `REDUCK_CONCURRENCY`
// (default 4), governs both — never run_script-with-many-args, just N separate runs throttled to N.

export const DEFAULT_LIMIT = Number(process.env.REDUCK_CONCURRENCY) || 4;

// gate(limit) — a FIFO admission gate: at most `limit` thunks run at once, the rest queue. Returns
// the acquire wrapper; ONE gate instance shared by all callers is a single global ceiling.
export const gate = (limit = DEFAULT_LIMIT) => {
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

// mapLimit(items, fn, limit) — map `fn` over `items` with at most `limit` in flight, results in
// input order. The ergonomic fan-out for batch tools; the runner's gate is the hard floor beneath it.
export const mapLimit = async <T, R>(
	items: T[],
	fn: (item: T, index: number) => Promise<R>,
	limit = DEFAULT_LIMIT
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
