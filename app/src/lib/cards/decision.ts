// The worked example: a Notion Decision → an EvidencedJudgment. The one place that knows a
// Decision's stored shape — `Output` (JSON), `Reasoning` (statements whose quotes are [start,end)
// char ranges), and `Input` (the lossless data map). We render the evidence live
// (`renderEvidence`) and each quote's text is `evidence.slice(start,end)` — no matching, exact by
// construction, so improving the renderer keeps ranges valid as long as the rendering is
// unchanged. The output rides raw, with its Prompt Output schema alongside — the card edits it in
// place, held to that contract; this adapter no longer knows the contracts.

import type { Decision } from "$lib/server/notion";
import { renderEvidence } from "$core/linkedin/evidence";
import type { EvidencedJudgment, Quote, Statement } from "./types";

// quotes in order of appearance in the evidence, so a cursor stepping through them moves
// strictly down the page.
const byStart = (quotes: Quote[]): Quote[] => [...quotes].sort((a, b) => a.start - b.start);

export const decisionToJudgment = (d: Decision): EvidencedJudgment => {
	const output = JSON.parse(d.fields.Output) as Record<string, unknown>;
	const evidence = renderEvidence(JSON.parse(d.fields.Input) as Record<string, string>);
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
		draft
	};
};
