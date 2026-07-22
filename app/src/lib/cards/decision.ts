// The worked example: a Notion Decision → an EvidencedJudgment. The one place that knows a
// Decision's stored shape — `Output` (JSON), `Reasoning` (statements whose quotes are [start,end)
// char ranges), and `Input` (the lossless data map). We render the evidence live
// (`renderEvidence`) and each quote's text is `evidence.slice(start,end)` — no matching, exact by
// construction, so improving the renderer keeps ranges valid as long as the rendering is
// unchanged. The output rides raw, with its Prompt Output schema alongside — the card edits it in
// place, held to that contract; this adapter no longer knows the contracts.

import type { Decision } from "$lib/server/notion";
import { renderEvidence, fieldSpan } from "$core/linkedin/evidence";
import { hasFeedback, reviewOf } from "$core/review";
import type { EvidencedJudgment, Quote, Statement } from "./types";

// A list row — the cheap projection of a Decision (no `renderEvidence`, no Output/Input parse
// beyond what the badge needs), so the list stays fast at any Past size. `verdict` is derived only
// for a decided row: Accepted (committed ≡ judge's Output) → "Confirmed", Rejected → "Edited".
export interface DecisionRow {
	id: string;
	name: string; // the Decision's title (the subject's name)
	kind: string; // the Prompt Name — the badge + the per-Prompt filter/sort key
	date: string; // created_time (ISO)
	hasFeedback: boolean; // any human channel touched (note / reasoning edit / overturn), both states
	verdict?: "Accepted" | "Rejected"; // past only — agreement, derived (never stored)
}

export const decisionToRow = (d: Decision): DecisionRow => ({
	id: d.id,
	name: d.title,
	kind: d.promptName ?? "",
	date: d.created,
	hasFeedback: hasFeedback(d.fields),
	verdict: d.fields["Final output"]
		? (reviewOf(d.fields).human.verdict as "Accepted" | "Rejected")
		: undefined
});

// quotes in order of appearance in the evidence, so a cursor stepping through them moves
// strictly down the page.
const byStart = (quotes: Quote[]): Quote[] => [...quotes].sort((a, b) => a.start - b.start);

export const decisionToJudgment = (d: Decision): EvidencedJudgment => {
	const output = JSON.parse(d.fields.Output) as Record<string, unknown>;
	const input = JSON.parse(d.fields.Input) as Record<string, string>;
	const evidence = renderEvidence(input);
	const order = (ss: Statement[]): Statement[] => ss.map((s) => ({ ...s, quotes: byStart(s.quotes) }));
	// a saved-but-undecided draft, when the human has already checkpointed work on this row:
	// their edited statements ("Final reasoning") and note ("Feedback"). Only present until a
	// decision is committed (a decided row leaves the queue). Quotes ordered like the judge's.
	const feedback = d.fields.Feedback ?? "";
	const draftReasoning = d.fields["Final reasoning"];
	const draft =
		draftReasoning || feedback
			? {
					feedback,
					reasoning: draftReasoning ? order(JSON.parse(draftReasoning) as Statement[]) : undefined
				}
			: undefined;
	return {
		id: d.id,
		title: d.title,
		href: d.url,
		statements: order(JSON.parse(d.fields.Reasoning) as Statement[]),
		evidence,
		output,
		outputSchema: d.outputSchema,
		proposal: d.proposal,
		// placement is code-computed, never the LLM's: the prompt names the Input field the output
		// answers (`anchorField`), and its rendered span attaches the composer below it. Unset ⇒ the
		// dock floats. Derived here from the frozen Input, exactly like `evidence` — never stored.
		anchor: d.anchorField ? (fieldSpan(input, d.anchorField) ?? undefined) : undefined,
		hasFeedback: hasFeedback(d.fields),
		draft
	};
};
