// Text anchoring — a quote is a half-open char range `[start, end)` into the frozen evidence
// `E = renderEvidence(Input)`. Because Input is fixed and the renderer deterministic, E is
// fixed, so a range denotes exactly one span: no content matching, no occurrence guessing, no
// drift. `E.slice(start, end)` is the quoted text — derived, never stored as truth. The LLM
// judge additionally reports the text it MEANT to cite (`intended_text`) as a debug + retry
// signal; a human quote omits it, because a selection's position already IS the span.

// A quote located by its bounds in E. `intended_text` is the LLM's self-report (present ⇒
// LLM-authored); humans omit it. The span is the whole anchor — nothing else is needed.
export interface Quote {
	start: number;
	end: number;
	intended_text?: string;
}

// A reasoning statement: a claim, its stance (for/against the verdict), and the evidence spans
// that back it — at least one; an unbacked claim is not a statement.
export interface Statement {
	claim: string;
	supporting: boolean;
	quotes: Quote[];
}

// A quote's identity is its span — the one place equality is defined, shared by the review
// diff, provenance (judge's vs human's) and dedupe.
export const quoteKey = (q: Quote): string => `${q.start}:${q.end}`;

// The text a quote resolves to in E — the single source of the displayed string.
export const quoteText = (evidence: string, q: Quote): string => evidence.slice(q.start, q.end);

// A quote is well-formed iff its half-open range lies within E — the one gate before a write.
export const inRange = (evidence: string, q: Quote): boolean =>
	Number.isInteger(q.start) &&
	Number.isInteger(q.end) &&
	0 <= q.start &&
	q.start <= q.end &&
	q.end <= evidence.length;

// Every Quote reachable in a verdict — the objects in any `quotes: []` array within it
// (statements plus any nested in the output). One deep-walk validates them all at once.
export const collectQuotes = (value: unknown): Quote[] => {
	const out: Quote[] = [];
	const walk = (v: unknown): void => {
		if (!v || typeof v !== "object") return;
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			if (k === "quotes" && Array.isArray(val)) out.push(...(val as Quote[]));
			else walk(val);
		}
	};
	walk(value);
	return out;
};

// snapQuote(evidence, q, window) — the offset-correction post-step (removable). Position markers
// (`annotate`) get the judge within ~tens of chars of its quote but not exact; here we pin it,
// deterministically, onto its OWN `intended_text`. The judge reproduces the RENDERED text (no `**`,
// collapsed whitespace), so we match in `canonicalize`'s rendered space — the same projection the
// human selection uses — then map the found span back to raw offsets via `at`. Local: the match is
// the occurrence nearest the judge's reported offset, within `window`, so it is unambiguous, never
// a global first-occurrence guess. A quote with no `intended_text` (a human's — already exact), or
// whose text isn't in-window, is returned unchanged. On success `intended_text` becomes the raw
// span, so `evidence.slice(start,end) === intended_text` holds.
export const snapQuote = (evidence: string, q: Quote, window = 128): Quote => {
	if (q.intended_text === undefined) return q; // human quote — position is already the truth
	const needle = canonNormalize(q.intended_text.replace(/⟨\d+⟩/g, ""));
	const { canon, at } = canonicalize(evidence);
	if (!needle || !at.length) return q;
	// the canon index nearest the judge's reported raw offset
	let approx = 0;
	for (let k = 1; k < at.length; k++)
		if (Math.abs(at[k] - q.start) < Math.abs(at[approx] - q.start)) approx = k;
	// the occurrence of the rendered needle nearest that index, within the window
	let best = -1;
	for (let i = canon.indexOf(needle); i >= 0; i = canon.indexOf(needle, i + 1))
		if (Math.abs(i - approx) <= window && (best < 0 || Math.abs(i - approx) < Math.abs(best - approx)))
			best = i;
	if (best < 0) return q;
	const start = at[best];
	const end = at[best + needle.length - 1] + 1;
	return { start, end, intended_text: evidence.slice(start, end) };
};

// mapQuotes(value, fn) — deep-copy a verdict, replacing every Quote in any `quotes:[]` with
// fn(quote). The write-side twin of collectQuotes; here it applies snapQuote across statements
// AND any quotes nested in the output.
export const mapQuotes = (value: unknown, fn: (q: Quote) => Quote): unknown => {
	if (Array.isArray(value)) return value.map((v) => mapQuotes(v, fn));
	if (!value || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>))
		out[k] = k === "quotes" && Array.isArray(v) ? (v as Quote[]).map(fn) : mapQuotes(v, fn);
	return out;
};

// annotate(text, step) — the LLM prompt aid: interleave position landmarks ⟨N⟩ into a copy of
// the evidence, one at the first whitespace past every `step` chars, where N is the offset of the
// character right after the marker. An LLM can't count thousands of chars from 0 (offsets drift
// worse the deeper the quote), but it can count <step chars from the nearest landmark. In-memory,
// prompt-only: the model reports offsets into the CLEAN text; the markers just tell it where it is.
// Stripping /⟨\d+⟩/g recovers the original exactly.
export const annotate = (text: string, step = 100): string => {
	let out = "";
	let since = 0;
	for (let i = 0; i < text.length; i++) {
		if (since >= step && /\s/.test(text[i])) {
			out += `⟨${i}⟩`;
			since = 0;
		}
		out += text[i];
		since++;
	}
	return out;
};

// canonicalize(E) — E projected into its RENDERED text space: whitespace runs collapse to a
// single space (never leading), and markdown syntax the renderer removes — inline emphasis
// (`**`) and line-leading block markers (`#`, `-`/`*`/`+`, `>`) — is stripped, with `at[k]`
// the source index of `canon[k]`. A browser selection is matched in this space (the visible
// text the human sees ≈ `canon`), and its approximate position disambiguates a repeat.
export const canonicalize = (evidence: string): { canon: string; at: number[] } => {
	let canon = "";
	const at: number[] = [];
	let lineStart = true;
	for (let i = 0; i < evidence.length; ) {
		const c = evidence[i];
		if (/\s/.test(c)) {
			if (c === "\n") lineStart = true;
			if (canon && canon[canon.length - 1] !== " ") (canon += " "), at.push(i);
			i++;
			continue;
		}
		const m = lineStart && /^(?:#{1,6}|[-*+]|>)[ \t]+/.exec(evidence.slice(i));
		if (m) {
			i += m[0].length;
			continue;
		}
		lineStart = false;
		if (c === "*" && evidence[i + 1] === "*") {
			i += 2;
			continue;
		}
		(canon += c), at.push(i), i++;
	}
	if (canon.endsWith(" ")) (canon = canon.slice(0, -1), at.pop());
	return { canon, at };
};

// Collapse a browser-visible string the way `canonicalize` collapses whitespace, so its length
// is an offset into `canon` and it matches `canon` substrings.
export const canonNormalize = (s: string): string => s.replace(/\s+/g, " ").trim();

// quoteAt(E, selection, approx) — the HUMAN seam. A DOM selection is the rendered view of E;
// canon-match its text and, when it repeats, pick the occurrence nearest `approx` (the canon-
// space offset of the text before the selection) — position in, right occurrence out, never a
// first-match guess. null when the text is genuinely absent from E (a true "can't anchor").
export const quoteAt = (evidence: string, selection: string, approx: number): Quote | null => {
	const { canon, at } = canonicalize(evidence);
	const needle = canonNormalize(selection);
	if (!needle) return null;
	const hits: number[] = [];
	for (let i = canon.indexOf(needle); i >= 0; i = canon.indexOf(needle, i + 1)) hits.push(i);
	if (!hits.length) return null;
	const cs = hits.reduce((best, h) => (Math.abs(h - approx) < Math.abs(best - approx) ? h : best));
	return { start: at[cs], end: at[cs + needle.length - 1] + 1 };
};
