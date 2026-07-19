// The seam between a reviewed subject and the review UI: an adapter maps a source record to an
// EvidencedJudgment (see decision.ts, the worked example), the card renders and edits it, and a
// Judgment carries the human's decision back. Types only — no markup, no persistence.

// The output of reviewing one card: the committed output plus optional free-text. The committed
// output IS the decision (schema-valid, seeded from the judge's and edited in place); `reasoning`
// is the human's edited statements (comments and added claims/quotes), present only when it differs
// from the judge's. `committedOutput` is absent for a Save — a judgment with the decision withheld:
// the edits persist, the row stays at the gate.
export interface Judgment {
	id: string;
	committedOutput?: Record<string, unknown>;
	feedback: string;
	reasoning?: Statement[];
}

// A quote located unambiguously in the evidence — W3C TextQuoteSelector shape. The judge's
// quotes are resolved to these at qualify time (see salesflock/src/anchor.ts); prefix/suffix
// carry only when the quote repeats.
export interface Selector {
	exact: string;
	prefix?: string;
	suffix?: string;
}

// One reasoning statement: a claim, its stance (for or against the verdict), and the
// evidence spans that back it — at least one; an unbacked claim is not a statement.
// `comment` is the human's — a note on why the claim is wrong (or right), never the judge's.
export interface Statement {
	claim: string;
	supporting: boolean;
	quotes: Selector[];
	comment?: string;
}

// A judgment that cites evidence: the reasoning as claim→proof statements, the evidence the
// claims point into, and the judge's structured output plus the schema it obeys. The output is
// the editable seed — the human commits it (verbatim or corrected) and that IS the decision; no
// separate headline (a redundant echo of the output) and no CTA (the output is the proposal).
export interface EvidencedJudgment {
	id: string; // stable key; what a Judgment refers back to
	title: string; // the source record's name — what a decided card's receipt line reads
	href?: string; // the source record (the Notion Decision page)
	statements: Statement[];
	evidence: string; // markdown — rendered live from the Input data map; quotes anchor into it
	output: Record<string, unknown>; // the judge's Output — the editable seed
	outputSchema?: Record<string, unknown>; // the Prompt's Output JSON Schema — the edit contract
	// a saved-but-undecided draft, when one exists: the human's note and edited statements
	// (Feedback / Final reasoning). The card seeds from this; `statements` stays the judge's
	// canonical copy, so provenance (which claim is whose) is still read off it.
	draft?: { feedback: string; reasoning?: Statement[] };
}
