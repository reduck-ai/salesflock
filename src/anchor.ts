// Text anchoring — tie a claim to the exact evidence it cites. The judge quotes the
// evidence verbatim; this resolves each quote to a W3C-style TextQuoteSelector that matches
// EXACTLY one span. The evidence is frozen onto the Decision and highlighted against that
// same snapshot, so there is no document drift — uniqueness of the exact quote is necessary
// and sufficient. No char offsets, no fuzzy matching: that machinery only earns its keep
// under drift (add an exact→fuzzy fallback the day evidence is ever highlighted live).

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
