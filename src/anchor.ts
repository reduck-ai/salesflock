// Text anchoring — tie a claim to the exact evidence it cites. The judge quotes the evidence
// verbatim; this resolves each quote to a W3C-style TextQuoteSelector that matches EXACTLY one
// span. A Decision freezes the quote TEXT and the input DATA — not the rendered evidence: the
// evidence is re-rendered deterministically from that data by the one renderer, and each quote
// is resolved against it live at read. No drift, because that render is deterministic over the
// frozen data and keeps cited value text verbatim; a quote a renderer change moves under simply
// fails to resolve and drops from the highlight. No char offsets, no fuzzy matching: uniqueness
// of the exact quote is necessary and sufficient.

// A quote located unambiguously: `exact`, plus just enough neighbouring text (prefix/suffix)
// to single out one occurrence when the quote repeats. Shape follows the W3C Web Annotation
// TextQuoteSelector (w3.org/TR/annotation-model/#text-quote-selector).
export interface Selector {
	exact: string;
	prefix?: string;
	suffix?: string;
}

// What the judge emits (quotes as raw strings) → what we store (quotes resolved to Selectors).
// `supporting` is the statement's stance: for or against the verdict it argues.
export interface RawStatement {
	claim: string;
	supporting: boolean;
	quotes: string[];
}
export interface Statement {
	claim: string;
	supporting: boolean;
	quotes: Selector[];
}

// The order-insensitive identity of a quote — the one place a Selector's equality is defined.
// Shared by both sides of a review: the app derives "the human's vs the judge's" as a set
// difference against the frozen judgment, and `diffStatements` recovers the same delta for
// learning. Lives with Selector so there is a single definition.
export const quoteKey = (s: Selector): string => `${s.exact} ${s.prefix ?? ""} ${s.suffix ?? ""}`;

// Every start index of `needle` in `haystack`.
const indicesOf = (haystack: string, needle: string): number[] => {
	const out: number[] = [];
	for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) out.push(i);
	return out;
};

// resolve(evidence, quote) → the unique Selector for the quote, or null when the quote is
// absent (the judge paraphrased instead of quoting). One occurrence needs no context; on
// several, grow a minimal symmetric prefix/suffix around the first until the triple is
// unambiguous.
export const resolve = (evidence: string, quote: string): Selector | null => {
	const hits = indicesOf(evidence, quote);
	if (hits.length === 0) return null;
	if (hits.length === 1) return { exact: quote };
	const at = hits[0];
	const end = at + quote.length;
	for (let k = 1; k <= evidence.length; k++) {
		const prefix = evidence.slice(Math.max(0, at - k), at);
		const suffix = evidence.slice(end, end + k);
		const collides = hits.some(
			(j) =>
				j !== at &&
				evidence.slice(Math.max(0, j - k), j) === prefix &&
				evidence.slice(j + quote.length, j + quote.length + k) === suffix
		);
		if (!collides) return { exact: quote, prefix, suffix };
	}
	// Identical text with identical surroundings throughout — every occurrence is equal
	// proof, so any single one is a valid anchor.
	return { exact: quote };
};

// resolveVisible(evidence, selection) — the HUMAN seam. A DOM selection is a
// whitespace-collapsed VIEW of the source (leading indentation dropped inside code blocks,
// newlines injected across blocks), so an exact match against the raw evidence fails — this
// is a coordinate mismatch, not a bad quote. Canonicalize away exactly what the render
// collapses (runs of whitespace → one space), match in canon space, map the span back to raw
// offsets, then defer to `resolve` for uniqueness. So a human quote is a real source span
// like the judge's and everything downstream (locate, diff, labelling) is untouched. null
// when the text is genuinely absent from the source — a true "can't anchor", never a guess.
export const resolveVisible = (evidence: string, selection: string): Selector | null => {
	// canon(evidence) + at[k] = the raw index of canon[k], in one pass. A whitespace run
	// becomes a single space (never leading); the endpoints we read back are always the
	// selection's non-space edges, so their raw indices are exact.
	let canon = "";
	const at: number[] = [];
	for (let i = 0; i < evidence.length; i++) {
		if (/\s/.test(evidence[i])) {
			if (canon && canon[canon.length - 1] !== " ") (canon += " "), at.push(i);
		} else (canon += evidence[i]), at.push(i);
	}
	if (canon.endsWith(" ")) (canon = canon.slice(0, -1), at.pop());

	const needle = selection.replace(/\s+/g, " ").trim();
	if (!needle) return null;
	const cs = canon.indexOf(needle);
	if (cs < 0) return null;
	return resolve(evidence, evidence.slice(at[cs], at[cs + needle.length - 1] + 1));
};

// resolveQuotes(evidence, value) — deep-walk a judge's structured output and resolve every
// `quotes: string[]` field to Selectors, in place. The statements rule, generalized: in a
// verdict, ANY field named `quotes` cites the evidence verbatim, so persistence always
// stores resolved anchors — never raw strings. Loud on a missing quote, like validate.
export const resolveQuotes = (evidence: string, value: unknown): void => {
	if (!value || typeof value !== "object") return;
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (k === "quotes" && Array.isArray(v) && v.every((q) => typeof q === "string")) {
			const sels = (v as string[]).map((q) => resolve(evidence, q));
			const missing = (v as string[]).filter((_, i) => !sels[i]);
			if (missing.length)
				throw new Error(
					`quotes not found verbatim in evidence:\n- ${missing.join("\n- ")}`
				);
			(value as Record<string, unknown>)[k] = sels;
		} else resolveQuotes(evidence, v);
	}
};

// validate(evidence, statements) → statements with every quote resolved to a unique Selector.
// Loud on failure: a statement with no quote is an unsupported claim, and a quote absent from
// the evidence is a broken anchor — either way we name the offenders and throw rather than
// store a dead link. The caller may retry the judge once.
export const validate = (evidence: string, statements: RawStatement[]): Statement[] => {
	const unsupported = statements.filter((s) => !s.quotes.length).map((s) => s.claim);
	if (unsupported.length)
		throw new Error(`statements with no quote:\n- ${unsupported.join("\n- ")}`);
	const missing: string[] = [];
	const resolved = statements.map((s) => ({
		...s,
		quotes: s.quotes.map((q) => {
			const sel = resolve(evidence, q);
			if (!sel) missing.push(q);
			return sel;
		})
	}));
	if (missing.length)
		throw new Error(`quotes not found verbatim in evidence:\n- ${missing.join("\n- ")}`);
	return resolved as Statement[];
};
