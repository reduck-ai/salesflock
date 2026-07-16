// The worked example: a Notion Decision → an EvidencedJudgment. This is the ONLY place that
// knows a Decision's shape — the structured verdict is JSON (`Output`: tier + engagement note
// + the planned first action), the reasoning is the statements JSON (`Reasoning`), and the
// frozen evidence markdown (`Input`) is what the claims' quotes resolve against. All three are
// written by `leads qualify` against the Prompt's contract, so we parse, not guess.

import type { Decision } from "$lib/server/notion";
import { locate } from "./highlight";
import type { EvidencedJudgment, Statement } from "./types";

interface NextStep {
	action: "comment_post" | "send_invite" | "none";
	postUrl?: string;
	comment?: string;
	note?: string;
}
interface Output {
	tier: "T1" | "T2" | "Not qualified";
	engagement_strategy: string;
	next_step: NextStep;
}

const TIER_COLOUR: Record<Output["tier"], string> = {
	T1: "#16a34a",
	T2: "#d97706",
	"Not qualified": "#dc2626"
};

// The structured next step → one human line. The lead's profileUrl is context, not shown here.
const nextStepLine = (n: NextStep): string => {
	switch (n.action) {
		case "comment_post":
			return `**Next step — comment on [a post](${n.postUrl})**\n\n_"${n.comment}"_`;
		case "send_invite":
			return n.note
				? `**Next step — send invite**\n\n_"${n.note}"_`
				: "**Next step — send invite** _(no note)_";
		default:
			return "";
	}
};

// The judgment's presentation invariant: a statement's quotes read in order of appearance
// in the frozen evidence, so a cursor stepping through them moves strictly down the page.
// Established once here, at the seam; unresolvable quotes sink to the end.
const byAppearance = (evidence: string, s: Statement): Statement => ({
	...s,
	quotes: [...s.quotes].sort((a, b) => {
		const pos = (sel: Statement["quotes"][number]) => {
			const at = locate(evidence, sel);
			return at < 0 ? Number.MAX_SAFE_INTEGER : at;
		};
		return pos(a) - pos(b);
	})
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
		cta: nextStepLine(o.next_step) || undefined,
		statements: (JSON.parse(d.fields.Reasoning) as Statement[]).map((s) => byAppearance(evidence, s)),
		evidence
	};
};
