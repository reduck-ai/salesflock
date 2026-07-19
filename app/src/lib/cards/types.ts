// A Validation Card is data, not markup. Anything you can reduce to a title, an
// optional badge, and a list of labelled sections becomes a card the stack can render
// and judge — so building a new card type is writing one function to CardModel, never
// touching the Tinder UI or the Accept/Reject/feedback surface. `decision.ts` is the
// worked example; add a sibling adapter for any other subject.

export interface Section {
	label?: string; // small inline heading; omit for a lead paragraph
	body: string;
	muted?: boolean; // secondary text — evidence, metadata
}

// tone maps 1:1 to the shadcn Badge variant, so a card author picks meaning, not CSS.
export interface Badge {
	text: string;
	tone: "default" | "secondary" | "destructive" | "outline";
}

export interface CardModel {
	id: string; // stable key; also what a judgment refers back to
	title: string;
	href?: string; // when set, the title links out (e.g. the source record)
	badge?: Badge;
	sections: Section[];
}

export type Verdict = "accepted" | "rejected";

// The output of reviewing one card: the human's call plus optional free-text. `cta` is the
// human's edited next-step text, `reasoning` the human's edited statements (comments and
// added claims/quotes) — each present only when it differs from the judge's. `verdict` is
// absent for a Save — a judgment with the decision withheld: the edits persist, the row
// stays at the gate.
export interface Judgment {
	id: string;
	verdict?: Verdict;
	feedback: string;
	cta?: string;
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

// The proposed next action, structured like a statement so it anchors into the evidence
// and the human can edit it: a fixed markdown head, the editable body text, and the quotes
// tying the action to what it responds to — at least one, like a statement's.
export interface Cta {
	head: string; // markdown — "Next step — …", never edited
	text?: string; // the judge's comment/note — the one editable field
	quotes: Selector[];
}

// A richer card for a judgment that cites evidence: a markdown verdict headline, the
// reasoning as claim→proof statements, an optional call to action, and the frozen evidence
// markdown the claims point into. `rationale` is the judge's prose — secondary, shown on
// demand. `output` is the judge's raw structured verdict, kept so a human edit can be
// re-fused into a corrected copy (Final output). The review screen renders this; the flat
// CardModel above stays for simpler subjects.
export interface EvidencedJudgment {
	id: string; // stable key; what a Judgment refers back to
	title: string; // the source record's name — what a decided card's receipt line reads
	href?: string; // the source record (the Notion Decision page)
	verdict: string; // markdown — an H1 headline, colour inline
	rationale?: string; // markdown — the judge's prose, behind a discreet toggle
	cta?: Cta;
	statements: Statement[];
	evidence: string; // markdown — frozen snapshot the quotes resolve against
	output: Record<string, unknown>; // the judge's Output, verbatim — Final output's base
	// a saved-but-undecided draft, when one exists: the human's note and edited statements
	// (Feedback / Final reasoning). The card seeds from this; `statements` stays the judge's
	// canonical copy, so provenance (which claim is whose) is still read off it.
	draft?: { feedback: string; reasoning?: Statement[] };
}
