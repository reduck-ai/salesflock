// The autocomplete engine — the ONE client half of inline suggestion, shared by every editor.
// Extracted from the Decisions textarea attachment (cards/autocomplete.ts) the moment a second
// surface (the Writer's CodeMirror editor) needed the same behavior: debounce a pause in typing,
// abort the request the last keystroke made obsolete, and drop any answer a newer keystroke has
// already superseded. That race logic is subtle and must exist exactly once.
//
// What it does NOT own: how a suggestion is PAINTED (a textarea mirror, a CM6 decoration) and what it
// is GROUNDED in (`ground` — the extra fields /api/complete discriminates on: a Decision id, or a
// document title). Those are the editor's and the surface's; this is the wire.

export interface Ctx {
	prefix: string; // text before the caret
	suffix?: string; // text after it (a surface that only completes at the end sends nothing)
	field?: string; // the field being edited, when the surface has named fields
}

export interface CompleterOpts {
	ground: Record<string, string | undefined>; // merged into the request — the grounding handle
	debounce?: number;
	minChars?: number;
	timeout?: number;
}

// The on/off preference — ONE declaration, both surfaces. "Do I want inline suggestions?" is a
// property of the person, not of the editor they happen to be in, so it lives beside the wire rather
// than in each painter: `suggest` gates on it, which means neither the textarea nor the CodeMirror
// painter carries a branch, a storage key, or a persistence rule of its own. Each only binds ⇧⇥ to
// `toggle` and shows the answer however it shows things.
const KEY = "autocomplete";
export const enabled = (): boolean =>
	typeof localStorage === "undefined" || localStorage.getItem(KEY) !== "off";
export const toggle = (): boolean => {
	const next = !enabled();
	localStorage.setItem(KEY, next ? "on" : "off");
	return next;
};

// A suggestion has a shelf life. Typical calls answer in ~450ms, but the provider's tail is real
// (measured: two calls at 11.1s and 14.0s with the same prompt size others served in 500ms). A ghost
// that lands that late describes a sentence the writer finished thinking about long ago, so it is
// worse than nothing: abandon it rather than paint it. Nothing here retries — a retry would double
// the load to produce an answer that is just as stale.
const TIMEOUT = 2500;

export const createCompleter = ({ ground, debounce = 150, minChars = 2, timeout = TIMEOUT }: CompleterOpts) => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let ctrl: AbortController | undefined;
	let seq = 0;

	const cancel = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		ctrl?.abort();
		seq++; // anything already in flight is now superseded
	};

	// suggest(ctx) — the continuation for this caret, or null when there is none to show: too little
	// text, an aborted request, an offline endpoint, or a newer call having taken over. Never throws,
	// and never resolves with a suggestion that is no longer the latest — a ghost is a nicety, so a
	// failure is simply no ghost, and a stale one would be worse than none.
	const suggest = (ctx: Ctx): Promise<string | null> => {
		cancel();
		if (!enabled() || ctx.prefix.trim().length < minChars) return Promise.resolve(null);
		const mine = seq;
		return new Promise((resolve) => {
			timer = setTimeout(async () => {
				ctrl = new AbortController();
				const stale = setTimeout(() => ctrl?.abort(), timeout);
				try {
					const res = await fetch("/api/complete", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ ...ground, ...ctx, suffix: ctx.suffix ?? "" }),
						signal: ctrl.signal
					});
					if (!res.ok || mine !== seq) return resolve(null);
					const { completion } = (await res.json()) as { completion?: string };
					if (mine !== seq) return resolve(null);
					resolve((completion ?? "").replace(/\s+$/, "") || null);
				} catch {
					resolve(null); // aborted, timed out, or offline
				} finally {
					clearTimeout(stale);
				}
			}, debounce);
		});
	};

	return { suggest, cancel };
};
