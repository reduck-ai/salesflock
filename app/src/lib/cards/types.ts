// The seam between a reviewed subject and the review UI: an adapter maps a source record to an
// EvidencedJudgment (see decision.ts, the worked example), the card renders and edits it, and a
// Judgment carries the human's decision back. Types only — no markup, no persistence.

import type { Quote } from "$core/anchor";

// What one card hands back: the human's WORKING COPY — the output as they have it, their note,
// their edited statements — and whether they are deciding. One payload, one bit, so a Save and a
// Confirm differ in what they MEAN, never in what they carry. `commit: false` keeps the working
// copy and leaves the row at the gate; `commit: true` makes that same output the decision.
export interface Judgment {
	id: string;
	output: Record<string, unknown>;
	feedback: string;
	reasoning?: Statement[];
	commit: boolean;
}

// A quote is a [start,end) char range into the evidence (see salesflock/src/anchor.ts) — its
// text is evidence.slice(start,end). Re-exported so the card imports one name.
export type { Quote };

// One reasoning statement: a claim, its stance (for or against the verdict), and the
// evidence spans that back it — at least one; an unbacked claim is not a statement.
// `comment` is the human's — a note on why the claim is wrong (or right), never the judge's.
export interface Statement {
	claim: string;
	supporting: boolean;
	quotes: Quote[];
	comment?: string;
}

// A judgment that cites evidence: the reasoning as claim→proof statements, the evidence the
// claims point into, and the judge's structured output plus the schema it obeys. The output is
// the editable seed — the human commits it (verbatim or corrected) and that IS the decision. It
// carries no CTA and no framing header: the Output schema's own field labels say what is proposed.
export interface EvidencedJudgment {
	id: string; // stable key; what a Judgment refers back to
	title: string; // the source record's name — the detail line a decided card's toast reads
	href?: string; // the source record (the Notion Decision page)
	statements: Statement[];
	evidence: string; // markdown — rendered live from the Input data map; quotes anchor into it
	// What the card opens on and edits: the human's latest word if they have one (a decision, else a
	// saved draft), otherwise the judge's proposal. The adapter resolves that precedence — the card
	// only ever sees "the output", which is why it needs no notion of review state.
	output: Record<string, unknown>;
	// The judge's own proposal, always — the baseline that says whether the human changed anything.
	// Distinct from `output` precisely because the two may differ; that difference IS an overturn.
	proposed: Record<string, unknown>;
	outputSchema?: Record<string, unknown>; // the Prompt's Output JSON Schema — the edit contract
	anchor?: Quote; // the evidence span the composer attaches BELOW (a writing prompt supplies it);
	// absent ⇒ the composer floats in the dock (a verdict about the whole subject, not one span)
	hasFeedback: boolean; // does this decision already carry a human delta (any channel, any state)
	// the other two parts of a saved working copy, when one exists: the human's note and edited
	// statements (Feedback / Final reasoning). The card seeds from this; `statements` stays the
	// judge's canonical copy, so provenance (which claim is whose) is still read off it. The saved
	// OUTPUT is not repeated here — it is already `output` above, by the precedence that field names.
	draft?: { feedback: string; reasoning?: Statement[] };
}
