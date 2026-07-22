// Evidence with each claim's proof marked. A quote is a [start,end) range in this exact evidence
// markdown; we bracket that range with sentinels, render the markdown once, then turn the
// sentinels into <mark>. The sentinels are private-use code points (built at runtime, so this
// file stays pure ASCII) that never occur in real text and pass through marked untouched — so
// they land at the EXACT text positions of the quote in the output, wherever the render put them.
//
// The invariant that keeps this correct for ANY markdown: a <mark> never crosses a tag boundary.
// Highlighting is a TREE operation, not a string splice — a quote may span bold labels,
// blockquotes, links or several blocks, so we wrap each contiguous run of text between tags in
// its own <mark> (all sharing the quote's si/mi), closing before every tag and reopening after.
// Every <mark> is thus contained in one text run and the HTML is well-formed by construction —
// the whole class of "mark straddles an element and the parser truncates it" cannot occur.

import { renderMd } from "$lib/md";
import type { Quote } from "./types";

const OPEN = String.fromCharCode(0xe000); // start of a marked span, followed by "si:mi"
const SEP = String.fromCharCode(0xe001); // end of the span's si:mi header
const CLOSE = String.fromCharCode(0xe002); // end of a marked span
const TOKEN = new RegExp(`(${OPEN}\\d+:\\d+${SEP}|${CLOSE})`); // a sentinel within a text run
const OPEN_ONE = new RegExp(`^${OPEN}(\\d+):(\\d+)${SEP}$`);

// Turn the sentinel-bracketed HTML into <mark>s without ever crossing a tag: split into tag /
// text segments (a tag passes straight through), and inside the open region wrap each text run.
// The first fragment of a quote is tagged `hl-start` so the CSS draws the left accent bar once,
// not on every run — a quote spanning tags/lines reads as one unbroken band, not stripes.
const markup = (html: string): string => {
	let cur: { si: string; mi: string } | null = null;
	let started = false; // has this quote emitted its first (hl-start) fragment yet?
	let out = "";
	for (const seg of html.split(/(<[^>]+>)/)) {
		if (seg.startsWith("<")) {
			out += seg; // a tag: never wrapped, so no <mark> can span it
			continue;
		}
		for (const tok of seg.split(TOKEN)) {
			if (!tok) continue;
			const m = tok.match(OPEN_ONE);
			if (m) ((cur = { si: m[1], mi: m[2] }), (started = false));
			else if (tok === CLOSE) cur = null;
			else if (cur) {
				out += `<mark class="hl${started ? "" : " hl-start"}" data-si="${cur.si}" data-mi="${cur.mi}">${tok}</mark>`;
				started = true;
			} else out += tok;
		}
	}
	return out;
};

// highlightEvidence(evidence, marks) → HTML with each quote's text wrapped in
// <mark class="hl" data-si=si data-mi=mi>. `si` is the statement index, so the UI lights up
// every quote of a hovered claim together; `mi` is the mark's index in `marks`, so a cursor can
// address one quote (a quote spanning tags becomes several <mark>s sharing its si/mi). Overlapping
// spans: the earlier one wins; an out-of-bounds range is dropped (never mis-highlighted). A caller
// may pin `mi` explicitly (so `data-mi` stays global when the evidence is rendered in slices);
// absent, it falls back to the array index (the whole-document case).
export const highlightEvidence = (
	evidence: string,
	marks: { si: number; q: Quote; mi?: number }[]
): string => {
	const spans = marks
		.map(({ si, q, mi }, i) => ({ si, mi: mi ?? i, start: q.start, end: q.end }))
		.filter((s) => s.start >= 0 && s.end <= evidence.length && s.start < s.end)
		.sort((a, b) => a.start - b.start);
	let out = "";
	let cursor = 0;
	for (const { si, mi, start, end } of spans) {
		if (start < cursor) continue; // skip overlaps
		out +=
			evidence.slice(cursor, start) + OPEN + si + ":" + mi + SEP + evidence.slice(start, end) + CLOSE;
		cursor = end;
	}
	out += evidence.slice(cursor);
	return markup(renderMd(out));
};
