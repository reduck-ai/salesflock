// A human-reviewed Decision, projected to what few-shot learning needs: the judge's original
// judgment and the delta the human introduced — nothing the columns don't hold. The read-side
// inverse of `decide()`'s write, and a sibling of the app's decisionToJudgment (which reads the
// same columns for display) — this reads them for *learning*.
//
// Pure and agent-agnostic on purpose: a function of a Decision's fields (no store, no I/O)
// touching only columns every Decision has, with `Output` kept opaque. `Input` is the frozen
// lossless data map (JSON — the example's X); a consumer renders it via the agent's renderer.
// Quotes are char ranges into that rendered evidence, so the delta compares them by span
// identity (`quoteKey`) — no anchoring, no text matching here.

import { quoteKey, type Quote, type Statement } from "./anchor.js";

// A Decision's fields as the store hands them back (Row.fields) — scalars keyed by column.
type Fields = Record<string, string | number | boolean>;
const text = (v: string | number | boolean | undefined): string => (v == null ? "" : String(v));

// A statement as Final reasoning stores it: a judge Statement optionally carrying the human's
// note (the review app writes `comment` onto the claim it annotates).
export type Commented = Statement & { comment?: string };

// The delta a review adds over the judge's reasoning. Comments annotate a judge claim; added are
// the human's own claims; attached are extra proofs pinned onto a judge claim. Deletions can't
// occur — review is comment+add only, by construction.
export interface ReasoningDelta {
	comments: { claim: string; comment: string }[];
	added: Statement[];
	attached: { claim: string; quotes: Quote[] }[];
}

export interface Review {
	input: string; // the frozen evidence data (JSON) — the example's X, rendered by the consumer
	judge: { verdict: unknown; reasoning: Statement[] }; // the original judgment (Output opaque)
	human: {
		verdict: string; // "Accepted" | "Rejected" — agree with / overturn the judge
		feedback?: string; // the note: the correction rationale
		output?: unknown; // the corrected Output, only when the human edited it
	} & ReasoningDelta;
}

// The Necessary-and-Sufficient snapshot of what the human added OVER the judge — the three
// orthogonal channels a review can touch, Occam-style: only a non-trivial channel is present.
// `reasoning` always rides (it is cheap to carry empty and lets a consumer destructure it), but a
// Feedback is produced only when at least one channel is non-empty (see feedbackOf → null).
export interface Feedback {
	outputChange?: { from: unknown; to: unknown }; // the human overturned the Output (committed only)
	note?: string; // the Feedback prose — the correction rationale
	reasoning: ReasoningDelta; // comments on judge claims, added claims, attached proofs
}

// diffStatements — the human layer, matched by claim text (a review never edits or reorders a
// judge claim): a claim absent from the original is added; a shared claim's quotes beyond the
// original set are attached; a non-empty `comment` is a comment. Quotes compare by span identity.
export const diffStatements = (original: Statement[], final: Commented[]): ReasoningDelta => {
	const origQuotes = new Map(original.map((s) => [s.claim, new Set(s.quotes.map(quoteKey))]));
	const delta: ReasoningDelta = { comments: [], added: [], attached: [] };
	for (const s of final) {
		const base = origQuotes.get(s.claim);
		if (!base) delta.added.push({ claim: s.claim, supporting: s.supporting, quotes: s.quotes });
		else {
			const extra = s.quotes.filter((q) => !base.has(quoteKey(q)));
			if (extra.length) delta.attached.push({ claim: s.claim, quotes: extra });
		}
		if (s.comment?.trim()) delta.comments.push({ claim: s.claim, comment: s.comment.trim() });
	}
	return delta;
};

const emptyDelta = (): ReasoningDelta => ({ comments: [], added: [], attached: [] });
const deltaEmpty = (d: ReasoningDelta): boolean =>
	!d.comments.length && !d.added.length && !d.attached.length;

// feedbackOf(fields) — the human delta over the judge, or null when the human added nothing (pure
// agreement, or a not-yet-touched row). The ONE extractor of the three channels, working in BOTH
// states (a saved draft has Feedback/Final reasoning but no Final output; a commit has all three).
// Never throws: the columns it reads are optional, and it is called across a whole listing.
export const feedbackOf = (fields: Fields): Feedback | null => {
	const note = text(fields.Feedback).trim() || undefined;
	const reasoning = fields["Final reasoning"]
		? diffStatements(json<Statement[]>(fields, "Reasoning"), json<Commented[]>(fields, "Final reasoning"))
		: emptyDelta();
	// An overturn is committed-only: comparing PARSED outputs (not text) so formatting never fakes one.
	const fo = fields["Final output"];
	const from = fo ? json<unknown>(fields, "Output") : undefined;
	const to = fo ? json<unknown>(fields, "Final output") : undefined;
	const outputChange =
		fo && JSON.stringify(from) !== JSON.stringify(to) ? { from, to } : undefined;
	if (!outputChange && !note && deltaEmpty(reasoning)) return null;
	return { ...(outputChange && { outputChange }), ...(note && { note }), reasoning };
};

// hasFeedback(fields) — exhaustive across all channels and both states.
export const hasFeedback = (fields: Fields): boolean => feedbackOf(fields) !== null;

// renderFeedback(fb) — the delta as compact Markdown, ORDERED by information gain (the correction
// first, then the rationale, then the reasoning edits) and carrying ONLY the delta — never the
// judge's own output/reasoning or the evidence, which a consumer already has and can re-derive.
export const renderFeedback = (fb: Feedback): string => {
	const lines: string[] = [];
	if (fb.outputChange)
		lines.push(`**Correction:** ${JSON.stringify(fb.outputChange.from)} → ${JSON.stringify(fb.outputChange.to)}`);
	if (fb.note) lines.push(`**Note:** ${fb.note}`);
	const { comments, added, attached } = fb.reasoning;
	if (!deltaEmpty(fb.reasoning)) {
		lines.push("**Reasoning edits:**");
		for (const c of comments) lines.push(`- commented "${c.claim}": ${c.comment}`);
		for (const a of added) lines.push(`- added (${a.supporting ? "for" : "against"}): "${a.claim}"`);
		for (const a of attached) lines.push(`- +${a.quotes.length} proof(s) on "${a.claim}"`);
	}
	return lines.join("\n");
};

// parse a JSON column, loud on malformed — a broken record is not a guess.
const json = <T>(fields: Fields, col: string): T => {
	try {
		return JSON.parse(text(fields[col])) as T;
	} catch (e) {
		throw new Error(`Decision "${col}" is not valid JSON: ${(e as Error).message}`);
	}
};

// reviewOf(fields) — a reviewed Decision's fields → its Review. The committed output IS the
// decision, so `Final output` is the sole record of a review: its presence means reviewed
// (throw otherwise — a missing one is an unreviewed row, not an empty diff), and agreement is
// *derived*, never stored — the human "Accepted" iff their committed output equals the judge's
// `Output`, else "Rejected" (they overturned it). The reasoning delta is empty when the human
// left the judge's reasoning untouched (no Final reasoning); `output` rides only when corrected.
export const reviewOf = (fields: Fields): Review => {
	if (!fields["Final output"]) throw new Error("Decision has no Final output — not reviewed yet");
	const output = json<unknown>(fields, "Output");
	const reasoning = json<Statement[]>(fields, "Reasoning");
	// The human layer is exactly the feedback delta; agreement is the ABSENCE of an overturn.
	const fb = feedbackOf(fields);
	return {
		input: text(fields.Input),
		judge: { verdict: output, reasoning },
		human: {
			verdict: fb?.outputChange ? "Rejected" : "Accepted",
			...(fb?.note && { feedback: fb.note }),
			...(fb?.outputChange && { output: fb.outputChange.to }),
			...(fb?.reasoning ?? emptyDelta())
		}
	};
};
