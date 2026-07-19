// The worked example: a Notion Decision → an EvidencedJudgment. The one place that knows a
// Decision's stored shape — `Output` (JSON), `Reasoning` (statements, quotes as verbatim
// strings), and `Input` (the lossless data map). We render the evidence live (`renderEvidence`)
// and resolve each quote's anchor against it here, so improving the renderer reflows every
// Decision with no re-judge. The output rides raw, with its Prompt Output schema alongside — the
// card edits it in place, held to that contract; this adapter no longer knows the contracts.

import type { Decision } from "$lib/server/notion";
import { renderEvidence } from "$agent/evidence";
import { resolve, type RawStatement } from "$core/anchor";
import { locate } from "./highlight";
import type { EvidencedJudgment, Selector, Statement } from "./types";

// The judgment's presentation invariant: quotes read in order of appearance in the rendered
// evidence, so a cursor stepping through them moves strictly down the page. Unresolvable quotes
// sink to the end.
const byAppearance = (evidence: string, quotes: Selector[]): Selector[] =>
	[...quotes].sort((a, b) => {
		const pos = (sel: Selector) => {
			const at = locate(evidence, sel);
			return at < 0 ? Number.MAX_SAFE_INTEGER : at;
		};
		return pos(a) - pos(b);
	});

// Raw quote strings → ordered Selectors, the anchor derived live against the rendered evidence.
// An unresolvable quote (the renderer moved under it) drops — it simply won't highlight.
const resolveQuotes = (evidence: string, quotes: string[]): Selector[] =>
	byAppearance(
		evidence,
		quotes.map((q) => resolve(evidence, q)).filter((s): s is Selector => s !== null)
	);

export const decisionToJudgment = (d: Decision): EvidencedJudgment => {
	const output = JSON.parse(d.fields.Output) as Record<string, unknown>;
	const evidence = renderEvidence(JSON.parse(d.fields.Input) as Record<string, string>);
	const order = (ss: (RawStatement & { comment?: string })[]): Statement[] =>
		ss.map((s) => ({ ...s, quotes: resolveQuotes(evidence, s.quotes) }));
	// a saved-but-undecided draft, when the human has already checkpointed work on this row:
	// their edited statements ("Final reasoning") and note ("Feedback"). Only present until a
	// decision is committed (a decided row leaves the queue). Quotes ordered like the judge's.
	const feedback = d.fields.Feedback ?? "";
	const draftReasoning = d.fields["Final reasoning"];
	const draft =
		draftReasoning || feedback
			? {
					feedback,
					reasoning: draftReasoning
						? order(JSON.parse(draftReasoning) as (RawStatement & { comment?: string })[])
						: undefined
				}
			: undefined;
	return {
		id: d.id,
		title: d.title,
		href: d.url,
		statements: order(JSON.parse(d.fields.Reasoning) as RawStatement[]),
		evidence,
		output,
		outputSchema: d.outputSchema,
		draft
	};
};
