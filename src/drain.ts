// Drain a store worklist — process a filter's rows one page at a time until none are left.
// Built for monotonic funnels: successfully processing a row ADVANCES it out of the filter, so
// re-querying the same filter naturally pages through the backlog with no cursor to carry. A row
// that fails stays in the filter; the seen-set keeps it from being re-attempted in this run, and
// the loop stops the moment a page yields nothing new — so an all-failing backlog terminates loud
// (batch already set the exit code) instead of spinning on the same page forever.

import { batch } from "./concurrency.js";
import type { Row, Store } from "./stores/index.js";

// `label` is the CALLER's word for the work, not this file's: a drain is a shape, and "drain" on a
// progress line says only that something is looping. The caller knows what it is doing to each row
// ("engage"), so it names it — same convention as mapLimit's label, which is what actually prints it.
// `opts.limit` bounds how many rows of a page are in flight at once. Absent ⇒ unbounded, which is
// right when the backends beneath already meter themselves (each client owns its own gate). It is
// NOT right when one page of rows means one burst against a single scarce address: a geo search on a
// paired device sends every outstanding query from the same IP, and six at once was enough to earn
// an HTTP 429 and a captcha from Brave — a block that then applied to ordinary browsing on that
// machine. The caller knows whether its width is free; this is how it says so.
export const drain = async <R>(
	store: Store,
	model: string,
	filter: object,
	run: (row: Row) => Promise<R>,
	label = "drain",
	{ limit }: { limit?: number } = {}
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
		out.push(...(await batch(fresh, run, label, { limit })));
	}
};
