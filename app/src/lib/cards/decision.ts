// The worked example: a Notion Decision → an EvidencedJudgment. This is the ONLY place that
// knows a Decision's shape — the structured verdict is JSON (`Output`: tier + engagement note
// + the planned first action), the reasoning is the statements JSON (`Reasoning`), and the
// frozen evidence markdown (`Input`) is what the claims' quotes resolve against. All three are
// written by `leads qualify` against the Prompt's contract, so we parse, not guess.

import type { Decision } from "$lib/server/notion";
import { locate } from "./highlight";
import type { Cta, EvidencedJudgment, Selector, Statement } from "./types";

// Mirrors the Prompt's anyOf: an actionable step always cites what it responds to
// (quotes, resolved at qualify time like a statement's); `none` carries nothing.
type NextStep =
	| { action: "comment_post"; postUrl: string; comment: string; quotes: Selector[] }
	| { action: "send_invite"; note?: string; quotes: Selector[] }
	| { action: "none" };
type Output = {
	tier: "T1" | "T2" | "Not qualified";
	engagement_strategy: string;
	next_step: NextStep;
};

const TIER_COLOUR: Record<Output["tier"], string> = {
	T1: "#16a34a",
	T2: "#d97706",
	"Not qualified": "#dc2626"
};

// The structured next step → a Cta: a fixed head, the editable body, its quotes. The
// lead's profileUrl is context, not shown here.
const toCta = (evidence: string, n: NextStep): Cta | undefined => {
	if (n.action === "none") return undefined;
	const quotes = byAppearance(evidence, n.quotes);
	return n.action === "comment_post"
		? { head: `**Next step — comment on [a post](${n.postUrl})**`, text: n.comment, quotes }
		: n.note
			? { head: "**Next step — send invite**", text: n.note, quotes }
			: { head: "**Next step — send invite** _(no note)_", quotes };
};

// The judgment's presentation invariant: quotes read in order of appearance in the frozen
// evidence, so a cursor stepping through them moves strictly down the page. Established
// once here, at the seam; unresolvable quotes sink to the end.
const byAppearance = (evidence: string, quotes: Selector[]): Selector[] =>
	[...quotes].sort((a, b) => {
		const pos = (sel: Selector) => {
			const at = locate(evidence, sel);
			return at < 0 ? Number.MAX_SAFE_INTEGER : at;
		};
		return pos(a) - pos(b);
	});

// The Output, unfused onto the card: the tier is the headline, the engagement note is the
// rationale (prose, shown on demand), the planned first action is the CTA. The statements
// between them are the primary reading.
export const decisionToJudgment = (d: Decision): EvidencedJudgment => {
	const o = JSON.parse(d.fields.Output) as Output;
	const evidence = d.fields.Input;
	return {
		id: d.id,
		href: d.url,
		verdict: `# <span style="color:${TIER_COLOUR[o.tier]}">${o.tier}</span>`,
		rationale: o.engagement_strategy,
		cta: toCta(evidence, o.next_step),
		statements: (JSON.parse(d.fields.Reasoning) as Statement[]).map((s) => ({
			...s,
			quotes: byAppearance(evidence, s.quotes)
		})),
		evidence,
		output: o
	};
};

// The adapter's inverse: the human's edited CTA text re-fused into a corrected Output —
// what a decide writes to Ground truth. Only the edited field moves; the rest stays the
// judge's, verbatim.
export const correct = (output: Record<string, unknown>, text: string): Record<string, unknown> => {
	const o = output as Output;
	const key = o.next_step.action === "send_invite" ? "note" : "comment";
	return { ...o, next_step: { ...o.next_step, [key]: text } };
};
