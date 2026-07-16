// Evidence with each claim's proof marked. Every Selector was resolved (at qualify time) to
// a unique span in this exact evidence markdown; here we find that span, wrap it in a
// sentinel, render the markdown once, then swap sentinels for <mark data-si> — so we mark in
// the source and style in the output, and a quote spanning inline markdown can't break the
// render. The sentinels are private-use code points (built at runtime, so this file stays
// pure ASCII) that never occur in real text and pass through snarkdown untouched.

import snarkdown from "snarkdown";
import type { Selector } from "./types";

const OPEN = String.fromCharCode(0xe000); // ⟦ start of a marked span
const SEP = String.fromCharCode(0xe001); // ⟧ end of the span's index
const CLOSE = String.fromCharCode(0xe002); // ⟠ end of a marked span
const OPEN_RE = new RegExp(`${OPEN}(\\d+):(\\d+)${SEP}`, "g");
const CLOSE_RE = new RegExp(CLOSE, "g");

// The unique start index of a selector in the evidence; prefix/suffix disambiguate repeats.
// Exported as the one place a quote's position is known — decision.ts sorts by it.
export const locate = (ev: string, s: Selector): number => {
	for (let i = ev.indexOf(s.exact); i >= 0; i = ev.indexOf(s.exact, i + 1)) {
		const preOk = !s.prefix || ev.slice(Math.max(0, i - s.prefix.length), i) === s.prefix;
		const sufOk =
			!s.suffix || ev.slice(i + s.exact.length, i + s.exact.length + s.suffix.length) === s.suffix;
		if (preOk && sufOk) return i;
	}
	return -1;
};

// highlightEvidence(evidence, marks) → HTML with each mark's span wrapped in
// <mark class="hl" data-si=si data-mi=mi>. `si` is the statement index, so the UI lights up
// every quote of a hovered claim together; `mi` is the mark's index in `marks`, so a cursor
// can address one quote. Overlapping spans: the earlier one wins.
export const highlightEvidence = (evidence: string, marks: { si: number; sel: Selector }[]): string => {
	const spans = marks
		.map(({ si, sel }, mi) => ({ si, mi, start: locate(evidence, sel), len: sel.exact.length }))
		.filter((s) => s.start >= 0)
		.sort((a, b) => a.start - b.start);
	let out = "";
	let cursor = 0;
	for (const { si, mi, start, len } of spans) {
		if (start < cursor) continue; // skip overlaps
		out +=
			evidence.slice(cursor, start) + OPEN + si + ":" + mi + SEP + evidence.slice(start, start + len) + CLOSE;
		cursor = start + len;
	}
	out += evidence.slice(cursor);
	return snarkdown(out)
		.replace(OPEN_RE, '<mark class="hl" data-si="$1" data-mi="$2">')
		.replace(CLOSE_RE, "</mark>");
};
