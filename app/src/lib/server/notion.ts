// Notion access for the review gate: one query for the pending queue, one write per human
// verdict. Schema-agnostic on purpose — a fork points NOTION_DECISIONS_DS at its own
// database and the page still renders. The one agent-specific input is `config.prompts`
// (via $agent): the map of decision kind → pipeline transition, shared with the runtime.
// NOTION_TOKEN is an internal-integration token the databases are shared with.

import { env } from "$env/dynamic/private";
import { chunks, plain, relation, type NotionValue } from "$core/stores/notion.codec";
import config from "$agent/config";

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
	deps: string[]; // upstream Decision ids ("Depends on") — the DAG edges
}

const page = async (id: string): Promise<{ properties: Record<string, NotionValue> }> => {
	const res = await fetch(`${API}/pages/${id}`, { headers });
	if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
	return res.json();
};

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
	const rows = results.map(({ id, url, properties }) => {
		let title = "";
		const fields: Record<string, string> = {};
		for (const [name, v] of Object.entries(properties)) {
			const s = plain(v);
			if (s == null || s === "") continue;
			if (v.type === "title") title = String(s);
			else fields[name] = String(s);
		}
		return { id, url, title, fields, deps: relation(properties["Depends on"]) };
	});

	// The DAG gate, derived at read time — never stored: a Decision is reviewable only once
	// every upstream it depends on is Accepted. A rejected upstream permanently hides its
	// dependents; the graph is the state, so there is no moot flag to keep in sync.
	const depIds = [...new Set(rows.flatMap((r) => r.deps))];
	const verdicts = new Map(
		await Promise.all(
			depIds.map(async (id) => [id, plain((await page(id)).properties["Human verdict"])] as const)
		)
	);
	return rows.filter((r) => r.deps.every((d) => verdicts.get(d) === "Accepted"));
};

const patch = async (pageId: string, properties: Record<string, unknown>) => {
	const res = await fetch(`${API}/pages/${pageId}`, {
		method: "PATCH",
		headers,
		body: JSON.stringify({ properties })
	});
	if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
};

// record(pageId, verdict, feedback, finalOutput?) — a judgment writes the human-owned
// columns. The verdict lands on the Decision page ("Human verdict" select + optional
// "Feedback" + optional "Final output", the output as the human accepted/sent it): the
// audit record of what the human decided. The pipeline move lands on the linked Lead
// ("Status") and is the Prompt's to declare, not ours: the Decision's Prompt row names its
// spec in config.prompts, and the verdict picks onAccept/onReject. An unknown prompt gets
// the verdict recorded but moves nothing — loud, so a config gap can't silently strand a
// Lead. Idempotent: re-deciding overwrites the same properties. Needs the integration's
// "Update content" capability on BOTH the Decisions and Leads databases.
export const record = async (
	pageId: string,
	verdict: "accepted" | "rejected",
	feedback: string,
	finalOutput?: string
) => {
	const accepted = verdict === "accepted";
	await patch(pageId, {
		"Human verdict": { select: { name: accepted ? "Accepted" : "Rejected" } },
		...(feedback ? { Feedback: { rich_text: chunks(feedback) } } : {}),
		...(finalOutput ? { "Final output": { rich_text: chunks(finalOutput) } } : {})
	});

	const { properties } = await page(pageId);
	const promptId = relation(properties.Prompt)[0];
	const promptName = promptId
		? Object.values((await page(promptId)).properties)
				.filter((p) => p.type === "title")
				.map(plain)[0]
		: null;
	const spec = Object.values(config.prompts).find((s) => s.name === promptName);
	if (!spec) {
		console.error(`record: no prompt spec for "${promptName}" — verdict written, Lead not moved`);
		return;
	}
	const status = accepted ? spec.onAccept : spec.onReject;
	await Promise.all(
		relation(properties.Lead).map((id) => patch(id, { Status: { select: { name: status } } }))
	);
};
