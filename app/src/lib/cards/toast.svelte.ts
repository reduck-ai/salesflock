// The toaster's state — the stack of acknowledgments, top-right, AND the queue of commits still in
// flight. Module state, not component state: each Confirm goto's to the next card's URL, remounting
// the page, and a toast must outlive that. (A full reload clears it, which is what a fresh visit
// means, and what makes this safe to keep in memory — see below.)
//
// A toast owns its own lifetime HERE rather than in the component, so firing one is fire-and-forget
// — no ondone round-trip back through the page to remove a single item. That is also what lets one
// component render the whole stack: without the timer, an item needs no child of its own.
//
// A RUN IN FLIGHT AND ITS RECEIPT ARE ONE FACT AT TWO MOMENTS OF ITS LIFE, so they are one object:
// a `pending` toast IS the queue entry, and `settle` turns it into the receipt in place — same id,
// same slot on screen. That is also why a commit's toast is keyed on the DECISION's id rather than
// a counter: it makes this one stack answer every question the queue raises, with no second
// structure to keep in step —
//
//   how many are running   toasts.filter(pending).length
//   which rows the rail must hide   the same filter (a row is hidden iff its commit is pending)
//   "one finished"         clearing `pending`; readers re-derive. No event bus.
//   where a failure sends you back   `/${id}` — the route param IS the id
//   one toast per decision  structural: same key, so a twin cannot be minted
//
// None of it belongs in Notion: a "Posting…" column would be the two-truths window the review flow
// exists to refuse (approved, and done), needing a reconciler for rows a crashed request left
// marked. The durable facts are the deed itself (`Comment URL`, `Posted at`, written by the act in
// the same patch as the Status) — this is only ever "requests THIS tab has outstanding", which dies
// correctly with the tab. What makes that safe rather than merely likely-fine is the act's own
// guard on the datum: it no-ops when its effect is already recorded, so a re-confirm cannot repeat it.

export interface Toast {
	id: string; // the keyed-each identity and the removal handle — for a commit, the Decision's id
	message: string; // the verb: Posting… / Confirmed / Edited / Saved / the server's refusal
	detail?: string; // what it happened to — the decision's title
	href?: string; // where it is worth going: the Notion page, or `/id` back to a failed card
	tone: "ok" | "edit" | "error";
	// In flight: the server has not answered yet. No timer while set — a pending toast waits for
	// `settle`. For the review deck it means exactly one thing: THE RAIL DOES NOT YET REFLECT THIS
	// DECISION, which is what lets the same flag serve as the hide-list. One bit, one lifetime.
	pending?: true;
}

// One duration, one lifetime: the timeout below and the countdown bar's `--dur` animate over the
// SAME value, so they can't drift — and the toast still dismisses under reduced motion (which
// would kill an animationend).
export const TOAST_MS = 3000;

// Exported as a const and only ever mutated: reassigning it would swap out the proxy every reader
// is subscribed to.
export const toasts = $state<Toast[]>([]);

let seq = 0;

// Who drains and who waits. A pending toast has nothing to report yet; an ERROR is never dropped on
// a timer, because a commit no longer blocks — a failure is discovered after the reviewer has moved
// on, so it has to sit there until it is read and dismissed. Both derived from what the toast
// already says; neither needs a field of its own.
const schedule = (t: Toast) => {
	if (!t.pending && t.tone !== "error") setTimeout(() => dismiss(t.id), TOAST_MS);
};

// Fire a toast; the id comes back so a pending one can be settled later. `id` is passed when the
// toast is ABOUT something that already has an identity (a Decision) — anonymous ones get a counter.
export const toast = (t: Omit<Toast, "id">, id: string = String(++seq)): string => {
	const item = { ...t, id };
	toasts.push(item);
	schedule(item);
	return id;
};

// settle(id, patch) — resolve a pending toast into its receipt, IN PLACE: the same object, so the
// keyed {#each} reuses the row and it flips where it stands instead of remounting at the bottom of
// the stack. Clearing `pending` IS the "it finished" event — no callback, no bus; every reader
// (the rail's hide-list, the appbar's count, the glyph) re-derives from the same bit.
//
// The optional channels are reset from the patch rather than merged over: the pending entry's
// detail/href described the attempt, and the receipt describes the outcome. Unknown id ⇒ no-op
// (dismissed by hand, or a stale reply after a reload).
export const settle = (id: string, patch: Omit<Toast, "id">) => {
	const t = toasts.find((x) => x.id === id);
	if (!t) return;
	Object.assign(t, { detail: undefined, href: undefined, ...patch, id, pending: undefined });
	schedule(t);
};

// The queue, as a READING of the same stack rather than a copy of it: every toast still awaiting
// its answer. A function, not a stored set — it reads the `$state` proxy, so a component's
// `$derived` that calls it tracks it, and there is no second structure that could fall out of step.
export const inFlight = (): Toast[] => toasts.filter((t) => t.pending);

export const dismiss = (id: string) => {
	const i = toasts.findIndex((t) => t.id === id);
	if (i >= 0) toasts.splice(i, 1); // guard: splice(-1, 1) would drop the newest toast instead
};
