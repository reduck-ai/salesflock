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

// The output of reviewing one card: the human's call plus optional free-text.
export interface Judgment {
	id: string;
	verdict: Verdict;
	feedback: string;
}

// A quote located unambiguously in the evidence — W3C TextQuoteSelector shape. The judge's
// quotes are resolved to these at qualify time (see salesflock/src/anchor.ts); prefix/suffix
// carry only when the quote repeats.
export interface Selector {
	exact: string;
	prefix?: string;
	suffix?: string;
}

// One reasoning statement: a claim and the evidence spans that back it.
export interface Statement {
	claim: string;
	quotes: Selector[];
}

// A richer card for a judgment that cites evidence: a free-form markdown verdict, the
// reasoning as claim→proof statements, and the frozen evidence markdown the claims point
// into. The review screen renders this; the flat CardModel above stays for simpler subjects.
export interface EvidencedJudgment {
	id: string; // stable key; what a Judgment refers back to
	href?: string; // the source record (the Notion Decision page)
	verdict: string; // markdown — an H1 headline, colour inline
	statements: Statement[];
	evidence: string; // markdown — frozen snapshot the quotes resolve against
}
