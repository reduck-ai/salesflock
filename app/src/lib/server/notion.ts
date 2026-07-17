// Read-only Notion access: one query against the Decisions data source, newest
// first, every property flattened to a plain string. Schema-agnostic on purpose —
// a fork points NOTION_DECISIONS_DS at its own database and the page still renders.
// NOTION_TOKEN is an internal-integration token the database is shared with.

import { env } from "$env/dynamic/private";
import { chunks, plain, type NotionValue } from "$core/stores/notion.codec";

const API = "https://api.notion.com/v1";
const headers = {
	Authorization: `Bearer ${env.NOTION_TOKEN}`,
	"Notion-Version": "2025-09-03",
	"Content-Type": "application/json"
};

export interface Decision {
	id: string;
	url: string;
	title: string;
	fields: Record<string, string>;
}

export const decisions = async (): Promise<Decision[]> => {
	const res = await fetch(`${API}/data_sources/${env.NOTION_DECISIONS_DS}/query`, {
		method: "POST",
		headers,
		// Only rows still awaiting a human call: a set "Human verdict" drops it from the queue,
		// so a decided card doesn't reappear on refresh. This is the review queue, not a log.
		body: JSON.stringify({
			filter: { property: "Human verdict", select: { is_empty: true } },
			sorts: [{ timestamp: "last_edited_time", direction: "descending" }]
		})
	});
	if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
	const { results } = (await res.json()) as {
		results: { id: string; url: string; properties: Record<string, NotionValue> }[];
	};
	return results.map(({ id, url, properties }) => {
		let title = "";
		const fields: Record<string, string> = {};
		for (const [name, v] of Object.entries(properties)) {
			const s = plain(v);
			if (s == null || s === "") continue;
			if (v.type === "title") title = String(s);
			else fields[name] = String(s);
		}
		return { id, url, title, fields };
	});
};

const patch = async (pageId: string, properties: Record<string, unknown>) => {
	const res = await fetch(`${API}/pages/${pageId}`, {
		method: "PATCH",
		headers,
		body: JSON.stringify({ properties })
	});
	if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
};

// record(pageId, verdict, feedback, groundTruth?) — a judgment writes the human-owned
// columns. The verdict lands on the Decision page ("Human verdict" select + optional
// "Feedback" + optional "Ground truth", the human's corrected output): the audit record of
// what the human decided. The pipeline move lands on the linked Lead ("Status"): accept
// advances it to "To engage", reject to "Not qualified" — the enum's own next stage past
// the approval gate. Idempotent: re-deciding overwrites the same properties. Needs the
// integration's "Update content" capability on BOTH the Decisions and Leads databases.
export const record = async (
	pageId: string,
	verdict: "accepted" | "rejected",
	feedback: string,
	groundTruth?: string
) => {
	const accepted = verdict === "accepted";
	await patch(pageId, {
		"Human verdict": { select: { name: accepted ? "Accepted" : "Rejected" } },
		...(feedback ? { Feedback: { rich_text: chunks(feedback) } } : {}),
		...(groundTruth ? { "Ground truth": { rich_text: chunks(groundTruth) } } : {})
	});

	const res = await fetch(`${API}/pages/${pageId}`, { headers });
	if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
	const { properties } = (await res.json()) as {
		properties: { Lead?: { relation: { id: string }[] } };
	};
	const status = accepted ? "To engage" : "Not qualified";
	await Promise.all(
		(properties.Lead?.relation ?? []).map((l) => patch(l.id, { Status: { select: { name: status } } }))
	);
};
