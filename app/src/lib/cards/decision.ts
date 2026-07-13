// The worked example: a Notion Decision → a CardModel. This is the ONLY place that
// knows a Decision's shape — Reasoning leads, the AI verdict becomes the badge, every
// other field trails as muted evidence. Point a new card type at its own source by
// writing a sibling of this function; nothing downstream changes.

import type { Decision } from "$lib/server/notion";
import type { Badge, CardModel } from "./types";

const badge = (verdict: string): Badge => ({
	text: verdict,
	tone: verdict === "Qualified" ? "default" : "secondary"
});

export const decisionToCard = (d: Decision): CardModel => {
	const { Decision: verdict, Reasoning, ...rest } = d.fields;
	const sections = [
		...(Reasoning ? [{ body: Reasoning }] : []),
		...Object.entries(rest).map(([label, body]) => ({ label, body, muted: true }))
	];
	return { id: d.id, title: d.title, href: d.url, badge: verdict ? badge(verdict) : undefined, sections };
};
