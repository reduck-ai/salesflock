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
		body: JSON.stringify({
			sorts: [{ timestamp: "last_edited_time", direction: "descending" }]
		})
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

const patch = async (pageId: string, properties: Record<string, unknown>) => {
	const res = await fetch(`${API}/pages/${pageId}`, {
		method: "PATCH",
		headers,
		body: JSON.stringify({ properties })
	});
	if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
};

// record(pageId, verdict, feedback) — a judgment writes two facts. The verdict lands on
// the Decision page ("Human verdict" select + optional "Feedback"): the audit record of
// what the human decided. The pipeline move lands on the linked Lead ("Status"): accept
// advances it to "To engage", reject to "Not qualified" — the enum's own next stage past
// the approval gate. Idempotent: re-deciding overwrites the same properties. Needs the
// integration's "Update content" capability on BOTH the Decisions and Leads databases.
export const record = async (
	pageId: string,
	verdict: "accepted" | "rejected",
	feedback: string
) => {
	const accepted = verdict === "accepted";
	await patch(pageId, {
		"Human verdict": { select: { name: accepted ? "Accepted" : "Rejected" } },
		...(feedback ? { Feedback: { rich_text: [{ text: { content: feedback } }] } } : {})
	});

	const res = await fetch(`${API}/pages/${pageId}`, { headers });
	if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
	const { properties } = (await res.json()) as {
		properties: { Lead?: { relation: { id: string }[] } };
	};
	const status = accepted ? "To engage" : "Not qualified";
	await Promise.all(
		(properties.Lead?.relation ?? []).map((l) =>
			patch(l.id, { Status: { select: { name: status } } })
		)
	);
};
