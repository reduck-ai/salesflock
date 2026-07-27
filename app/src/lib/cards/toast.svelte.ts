// The toaster's state — the stack of transient acknowledgments, top-right. Module state, not
// component state: each Confirm goto's to the next card's URL, remounting the page, and a toast
// must outlive that. (A full reload clears it, which is what a fresh visit means.)
//
// A toast owns its own lifetime HERE rather than in the component, so firing one is fire-and-forget
// — no ondone round-trip back through the page to remove a single item. That is also what lets one
// component render the whole stack: without the timer, an item needs no child of its own.

export interface Toast {
	id: number; // monotonic — the keyed-each identity and the removal handle
	message: string; // the verb: Confirmed / Edited / Saved / the server's refusal
	detail?: string; // what it happened to — the decision's title
	href?: string; // the Notion page, when the toast is worth re-opening
	tone: "ok" | "edit" | "error";
}

// One duration, one lifetime: the timeout below and the countdown bar's `--dur` animate over the
// SAME value, so they can't drift — and the toast still dismisses under reduced motion (which
// would kill an animationend).
export const TOAST_MS = 3000;

// Exported as a const and only ever mutated: reassigning it would swap out the proxy every reader
// is subscribed to.
export const toasts = $state<Toast[]>([]);

let seq = 0;

export const toast = (t: Omit<Toast, "id">) => {
	const id = ++seq;
	toasts.push({ ...t, id });
	setTimeout(() => dismiss(id), TOAST_MS);
};

export const dismiss = (id: number) => {
	const i = toasts.findIndex((t) => t.id === id);
	if (i >= 0) toasts.splice(i, 1); // guard: splice(-1, 1) would drop the newest toast instead
};
