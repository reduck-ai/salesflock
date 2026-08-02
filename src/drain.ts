// Drain a store worklist — process a filter's rows one page at a time until none are left.
// Built for monotonic funnels: successfully processing a row ADVANCES it out of the filter, so
// re-querying the same filter naturally pages through the backlog with no cursor to carry. A row
// that fails stays in the filter; the seen-set keeps it from being re-attempted in this run, and
// the loop stops the moment a page yields nothing new — so an all-failing backlog terminates loud
// (batch already set the exit code) instead of spinning on the same page forever.

import { batch } from "./concurrency.js";
import type { Row, Store } from "./stores/index.js";

export const drain = async <R>(
	store: Store,
	model: string,
	filter: object,
	run: (row: Row) => Promise<R>
): Promise<(R | { item: Row; error: string })[]> => {
	const out: (R | { item: Row; error: string })[] = [];
	const seen = new Set<string>();
	for (;;) {
		const { rows } = await store.queryPage(model, filter);
		const fresh = rows.filter((r) => !seen.has(r.id));
		if (!fresh.length) return out; // empty, or only rows this run already attempted
		fresh.forEach((r) => seen.add(r.id));
		// Labelled, so a drain reports m/n as it goes: this loop is the other place a run spends minutes
		// with nothing to show for it. The n is the PAGE, not the backlog — the whole point of draining
		// is that the total is not known in advance (rows leave the filter as they are processed, and
		// new ones can arrive while it runs), so a page is the largest honest denominator. The
		// backlog-wide count is what `--dry-run` is for.
		out.push(...(await batch(fresh, run, "drain")));
	}
};
