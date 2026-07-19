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

const page = async (
	id: string
): Promise<{ id: string; url: string; properties: Record<string, NotionValue> }> => {
	const res = await fetch(`${API}/pages/${id}`, { headers });
	if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
	return res.json();
};

// One page → a Decision: its title, its writable scalars flattened, and its "Depends on"
// edges. The one mapping, shared by the queue (decisions) and the deep link (decision).
const toDecision = ({
	id,
	url,
	properties
}: {
	id: string;
	url: string;
	properties: Record<string, NotionValue>;
}): Decision => {
	let title = "";
	const fields: Record<string, string> = {};
	for (const [name, v] of Object.entries(properties)) {
		const s = plain(v);
		if (s == null || s === "") continue;
		if (v.type === "title") title = String(s);
		else fields[name] = String(s);
	}
	return { id, url, title, fields, deps: relation(properties["Depends on"]) };
};

// decision(id) — one Decision by id, for a deep link. No gate: a link opens its decision
// whatever its state (decided or blocked); the DAG gate governs only the queue's ordering.
export const decision = async (id: string): Promise<Decision> => toDecision(await page(id));

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
	const rows = results.map(toDecision);

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

// record(pageId, verdict?, feedback, finalOutput?, finalReasoning?) — a judgment writes the
// human-owned columns. Without a verdict it is a Save: the human's work is persisted
// ("Feedback" + "Final reasoning", the statements as the human has them so far — comments and
// added claims included; "Reasoning" stays the judge's, verbatim), but the decision is
// withheld — no "Human verdict", no pipeline move — so the row stays in the queue. With a
// verdict it is a decision: "Human verdict" lands too, and the pipeline move lands on the
// linked Lead ("Status"), the Prompt's to declare not ours — the Decision's Prompt row names
// its spec in config.prompts and the verdict picks onAccept/onReject. An unknown prompt gets
// the verdict recorded but moves nothing — loud, so a config gap can't silently strand a
// Lead. Idempotent: re-deciding overwrites the same properties. Needs the integration's
// "Update content" capability on BOTH the Decisions and Leads databases.
export const record = async (
	pageId: string,
	verdict: "accepted" | "rejected" | undefined,
	feedback: string,
	finalOutput?: string,
	finalReasoning?: string
) => {
	await patch(pageId, {
		...(verdict
			? { "Human verdict": { select: { name: verdict === "accepted" ? "Accepted" : "Rejected" } } }
			: {}),
		...(feedback ? { Feedback: { rich_text: chunks(feedback) } } : {}),
		...(finalOutput ? { "Final output": { rich_text: chunks(finalOutput) } } : {}),
		...(finalReasoning ? { "Final reasoning": { rich_text: chunks(finalReasoning) } } : {})
	});
	if (!verdict) return; // a Save: edits persisted, decision withheld, Lead not moved

	const accepted = verdict === "accepted";
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
