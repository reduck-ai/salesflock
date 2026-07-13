// Read-only Notion access: one query against the Decisions data source, newest
// first, every property flattened to a plain string. Schema-agnostic on purpose —
// a fork points NOTION_DECISIONS_DS at its own database and the page still renders.
// NOTION_TOKEN is an internal-integration token the database is shared with.

import { env } from "$env/dynamic/private";

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

interface Value {
	type: string;
	[key: string]: unknown;
}

// A property value → plain text, or null for types with no scalar reading.
const plain = (v: Value): string | null => {
	const x = v[v.type];
	switch (v.type) {
		case "title":
		case "rich_text":
			return (x as { plain_text: string }[]).map((t) => t.plain_text).join("");
		case "url":
		case "email":
		case "phone_number":
			return (x as string | null) ?? null;
		case "number":
		case "checkbox":
			return x == null ? null : String(x);
		case "date":
			return (x as { start: string } | null)?.start ?? null;
		case "select":
		case "status":
			return (x as { name: string } | null)?.name ?? null;
		case "multi_select":
			return (x as { name: string }[]).map((o) => o.name).join(", ") || null;
		default:
			return null;
	}
};

export const decisions = async (): Promise<Decision[]> => {
	const res = await fetch(`${API}/data_sources/${env.NOTION_DECISIONS_DS}/query`, {
		method: "POST",
		headers,
		body: JSON.stringify({ sorts: [{ timestamp: "last_edited_time", direction: "descending" }] })
	});
	if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
	const { results } = (await res.json()) as {
		results: { id: string; url: string; properties: Record<string, Value> }[];
	};
	return results.map(({ id, url, properties }) => {
		let title = "";
		const fields: Record<string, string> = {};
		for (const [name, v] of Object.entries(properties)) {
			const s = plain(v);
			if (s == null || s === "") continue;
			if (v.type === "title") title = s;
			else fields[name] = s;
		}
		return { id, url, title, fields };
	});
};

// record(pageId, verdict, feedback) — write a human's review back onto the page:
// "Human verdict" (a select) and, when given, "Feedback" (rich text). Idempotent by
// nature — deciding the same card again overwrites the same two properties. Needs the
// integration's "Update content" capability; those two properties must exist on the DB.
export const record = async (pageId: string, verdict: "accepted" | "rejected", feedback: string) => {
	const properties: Record<string, unknown> = {
		"Human verdict": { select: { name: verdict === "accepted" ? "Accepted" : "Rejected" } },
		...(feedback ? { Feedback: { rich_text: [{ text: { content: feedback } }] } } : {})
	};
	const res = await fetch(`${API}/pages/${pageId}`, {
		method: "PATCH",
		headers,
		body: JSON.stringify({ properties })
	});
	if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
};
