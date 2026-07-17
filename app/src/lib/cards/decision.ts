// The worked example: a Notion Decision → an EvidencedJudgment. This is the ONLY place that
// knows a Decision's shape — the structured verdict is JSON (`Output`), the reasoning is the
// statements JSON (`Reasoning`), and the frozen evidence markdown (`Input`) is what the
// claims' quotes resolve against. All three are written by `leads qualify` / `leads engage`
// against the Prompt's contract, so we parse, not guess. Two contracts, one discriminator:
// a qualification Output carries `tier`, an engagement Output carries `next_step`.

import type { Decision } from "$lib/server/notion";
import { locate } from "./highlight";
import type { Cta, EvidencedJudgment, Selector, Statement } from "./types";

// Mirrors the engagement Prompt's anyOf: an actionable step always cites what it responds
// to (quotes, resolved at decide time like a statement's).
type NextStep =
	| { action: "comment_post"; postUrl: string; comment: string; quotes: Selector[] }
	| { action: "send_invite"; note?: string; quotes: Selector[] };
type QualifyOutput = { tier: "T1" | "T2" | "Not qualified" };
type EngageOutput = { engagement_strategy: string; next_step: NextStep };

const TIER_COLOUR: Record<QualifyOutput["tier"], string> = {
	T1: "#16a34a",
	T2: "#d97706",
	"Not qualified": "#dc2626"
};

// The structured next step → a Cta: a fixed head, the editable body, its quotes. The
// lead's profileUrl is context, not shown here.
const toCta = (evidence: string, n: NextStep): Cta => {
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

// The Output onto the card, by contract. Qualification: the tier is the headline, nothing
// else — the statements are the whole reading. Engagement: the action is the headline, the
// strategy note the rationale (prose, shown on demand), the drafted action the CTA.
export const decisionToJudgment = (d: Decision): EvidencedJudgment => {
	const o = JSON.parse(d.fields.Output) as Record<string, unknown>;
	const evidence = d.fields.Input;
	const head =
		"tier" in o
			? { verdict: tierHeadline((o as QualifyOutput).tier) }
			: {
					verdict: `# <span style="color:#2563eb">${(o as EngageOutput).next_step.action === "comment_post" ? "Comment" : "Invite"}</span>`,
					rationale: (o as EngageOutput).engagement_strategy,
					cta: toCta(evidence, (o as EngageOutput).next_step)
				};
	return {
		id: d.id,
		title: d.title,
		href: d.url,
		...head,
		statements: (JSON.parse(d.fields.Reasoning) as Statement[]).map((s) => ({
			...s,
			quotes: byAppearance(evidence, s.quotes)
		})),
		evidence,
		output: o
	};
};

const tierHeadline = (tier: QualifyOutput["tier"]): string =>
	`# <span style="color:${TIER_COLOUR[tier]}">${tier}</span>`;

// The adapter's inverse: the human's edited CTA text re-fused into a corrected Output —
// what a decide writes to Final output. Only the edited field moves; the rest stays the
// judge's, verbatim. Engagement-only, like the CTA itself.
export const correct = (output: Record<string, unknown>, text: string): Record<string, unknown> => {
	const o = output as EngageOutput;
	const key = o.next_step.action === "send_invite" ? "note" : "comment";
	return { ...o, next_step: { ...o.next_step, [key]: text } };
};
