// Text anchoring — a quote is a half-open char range `[start, end)` into the frozen evidence
// `E = renderEvidence(Input)`. Because Input is fixed and the renderer deterministic, E is
// fixed, so a range denotes exactly one span: no content matching, no occurrence guessing, no
// drift. `E.slice(start, end)` is the quoted text — derived, never stored as truth. Neither source
// invents a range: the LLM cites text and `findQuotes` returns the span (the `search_quotes` tool),
// a human selects and `quoteAt` returns it — so the span is the whole anchor, nothing else stored.

// A quote located by its bounds in E. The span is the whole anchor — nothing else is needed, and
// nothing else is stored: both sources produce it deterministically (the LLM via `search_quotes`
// over `findQuotes`, a human via `quoteAt` over a DOM selection), so E.slice(start,end) is the
// text, always — no self-reported `intended_text` to reconcile.
export interface Quote {
	start: number;
	end: number;
}

// A reasoning statement: a claim, its stance (for/against the verdict), and the evidence spans
// that back it — one per distinct proof, or none when the claim rests on the ABSENCE of evidence
// (nothing to point at; the evidence's silence is the proof).
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

// findQuotes(evidence, text) — the one anchoring primitive: every span in E whose RENDERED text is
// `text`, as raw {start,end} ranges. Match in `canonicalize`'s rendered space so a verbatim quote
// resolves whether it was copied from the rendered view or the raw markdown (`**`, bullets, headers),
// then map each canon occurrence back to raw offsets via `at`. This is what code — never the LLM —
// uses to turn text into offsets: `search_quotes` returns these (with context) for the judge to pick
// from, and `quoteAt` picks the one nearest a human selection. [] when the text isn't in E.
export const findQuotes = (evidence: string, text: string): Quote[] => {
	const { canon, at } = canonicalize(evidence);
	const needle = canonNormalize(text);
	if (!needle) return [];
	const out: Quote[] = [];
	for (let i = canon.indexOf(needle); i >= 0; i = canon.indexOf(needle, i + 1))
		out.push({ start: at[i], end: at[i + needle.length - 1] + 1 });
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
		// An HTML tag is invisible chrome — the renderer may emit them (the X evidence is a tweet
			// card, not plain markdown), so skip the whole tag like a markdown marker: its text content
			// stays in canon, only the tag characters drop, keeping canon ≈ the visible DOM.
			if (c === "<") {
				const tag = /^<\/?[a-zA-Z!][^>]*>/.exec(evidence.slice(i));
				if (tag) {
					i += tag[0].length;
					continue;
				}
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
export const canonNormalize = (s: string): string =>
	s.replace(/<\/?[a-zA-Z!][^>]*>/g, "").replace(/\s+/g, " ").trim();

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
