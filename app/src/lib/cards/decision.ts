// The worked example: a Notion Decision → an EvidencedJudgment. This is the ONLY place that
// knows a Decision's shape — the verdict is markdown (`Decision`), the reasoning is the
// statements JSON the judge wrote (`Reasoning`), and the frozen evidence markdown
// (`Evidence`) is what the claims' quotes resolve against. Point a new card type at its own
// source by writing a sibling of this function; nothing downstream changes.

import type { Decision } from "$lib/server/notion";
import type { EvidencedJudgment, Statement } from "./types";

// Reasoning holds `[{claim, quotes:[Selector]}]`. Decisions written before this shape existed
// carry free-text prose — degrade to a single quote-less claim rather than fail the page.
const parseStatements = (reasoning?: string): Statement[] => {
	if (!reasoning) return [];
	try {
		const v = JSON.parse(reasoning);
		return Array.isArray(v) ? (v as Statement[]) : [{ claim: reasoning, quotes: [] }];
	} catch {
		return [{ claim: reasoning, quotes: [] }];
	}
};

export const decisionToJudgment = (d: Decision): EvidencedJudgment => ({
	id: d.id,
	href: d.url,
	verdict: d.fields.Decision ?? d.title,
	statements: parseStatements(d.fields.Reasoning),
	evidence: d.fields.Evidence ?? ""
});
