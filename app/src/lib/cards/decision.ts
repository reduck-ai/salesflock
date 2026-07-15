// The worked example: a Notion Decision → an EvidencedJudgment. This is the ONLY place that
// knows a Decision's shape — the structured verdict is JSON (`Output`: tier + engagement note
// + the planned first action), the reasoning is the statements JSON (`Reasoning`), and the
// frozen evidence markdown (`Input`) is what the claims' quotes resolve against. All three are
// written by `leads qualify` against the Prompt's contract, so we parse, not guess.

import type { Decision } from "$lib/server/notion";
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
			return n.note ? `**Next step — send invite**\n\n_"${n.note}"_` : "**Next step — send invite** _(no note)_";
		default:
			return "";
	}
};

// The Output → the card's markdown verdict: a tier-coloured headline, the engagement note, and
// the planned first action. Reasoning (claims) and evidence render as before.
const verdictOf = (o: Output): string =>
	[`# <span style="color:${TIER_COLOUR[o.tier]}">${o.tier}</span>`, o.engagement_strategy, nextStepLine(o.next_step)]
		.filter(Boolean)
		.join("\n\n");

export const decisionToJudgment = (d: Decision): EvidencedJudgment => ({
	id: d.id,
	href: d.url,
	verdict: verdictOf(JSON.parse(d.fields.Output) as Output),
	statements: JSON.parse(d.fields.Reasoning) as Statement[],
	evidence: d.fields.Input
});
