// Notion access for the review gate: one query for the pending queue, one write per committed
// decision. Schema-agnostic on purpose — a fork points NOTION_DECISIONS_DS at its own database
// and the page still renders. The one agent-specific input is `config.prompts` (via $agent): a
// prompt's `resolve` maps a committed output → its pipeline move + polarity, shared with the
// runtime. NOTION_TOKEN is an internal-integration token the databases are shared with.

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
	prompt?: string; // the Prompt page id — its Output schema governs the editable output
	outputSchema?: Record<string, unknown>; // the Prompt's Output JSON Schema (the edit contract)
}

// A Prompt page → its Name and Output JSON Schema (the contract the human's output obeys).
const promptInfo = async (id: string): Promise<{ name: string; outputSchema?: Record<string, unknown> }> => {
	const { properties } = await page(id);
	const name = String(
		Object.values(properties)
			.filter((p) => p.type === "title")
			.map(plain)[0] ?? ""
	);
	const schema = plain(properties["Output schema"]);
	return { name, outputSchema: schema ? (JSON.parse(String(schema)) as Record<string, unknown>) : undefined };
};

// The prompt's pipeline semantics, by its Name — the same `resolve` the runtime declares.
const specByName = (name: string) => Object.values(config.prompts ?? {}).find((s) => s.name === name);

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
	return {
		id,
		url,
		title,
		fields,
		deps: relation(properties["Depends on"]),
		prompt: relation(properties.Prompt)[0]
	};
};

// decision(id) — one Decision by id, for a deep link. No gate: a link opens its decision
// whatever its state (decided or blocked); the DAG gate governs only the queue's ordering.
export const decision = async (id: string): Promise<Decision> => {
	const d = toDecision(await page(id));
	if (d.prompt) d.outputSchema = (await promptInfo(d.prompt)).outputSchema;
	return d;
};

export const decisions = async (): Promise<Decision[]> => {
	const res = await fetch(`${API}/data_sources/${env.NOTION_DECISIONS_DS}/query`, {
		method: "POST",
		headers,
		// Only rows still awaiting review: the committed output IS the decision, so an unset
		// "Final output" is the pending marker — a decided card drops from the queue and doesn't
		// reappear on refresh. This is the review queue, not a log.
		body: JSON.stringify({
			filter: { property: "Final output", rich_text: { is_empty: true } },
			sorts: [{ timestamp: "last_edited_time", direction: "descending" }]
		})
	});
	if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
	const { results } = (await res.json()) as {
		results: { id: string; url: string; properties: Record<string, NotionValue> }[];
	};
	const rows = results.map(toDecision);

	// The editable output's contract: each row's Prompt Output schema (prompts deduped).
	const schemas = new Map(
		await Promise.all(
			[...new Set(rows.map((r) => r.prompt).filter((p): p is string => !!p))].map(
				async (id) => [id, (await promptInfo(id)).outputSchema] as const
			)
		)
	);
	for (const r of rows) if (r.prompt) r.outputSchema = schemas.get(r.prompt);

	// The DAG gate, derived at read time — never stored: a Decision is reviewable only once
	// every upstream it depends on has *advanced* the pipeline. Polarity is derived from the
	// upstream's committed output via the same `resolve` the pipeline uses — a non-advancing
	// outcome (e.g. "Not qualified") permanently hides its speculative dependents. The graph is
	// the state, so there is no moot flag to keep in sync.
	const depIds = [...new Set(rows.flatMap((r) => r.deps))];
	const advances = new Map(
		await Promise.all(
			depIds.map(async (id) => {
				const { properties } = await page(id);
				const fo = plain(properties["Final output"]);
				const pid = relation(properties.Prompt)[0];
				const spec = fo && pid ? specByName((await promptInfo(pid)).name) : undefined;
				try {
					return [id, !!spec && spec.resolve(JSON.parse(String(fo))).advances] as const;
				} catch {
					return [id, false] as const;
				}
			})
		)
	);
	return rows.filter((r) => r.deps.every((d) => advances.get(d)));
};

const patch = async (pageId: string, properties: Record<string, unknown>) => {
	const res = await fetch(`${API}/pages/${pageId}`, {
		method: "PATCH",
		headers,
		body: JSON.stringify({ properties })
	});
	if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
};

// record(pageId, { committedOutput?, feedback, finalReasoning }) — a review writes the
// human-owned columns. The learning channel ("Feedback" + "Final reasoning", the statements
// as the human has them — comments and added claims included; "Reasoning" stays the judge's,
// verbatim) is always persisted. Absent `committedOutput` it is a Save: only that channel
// lands, no "Final output", so the row stays in the queue. Present, it is the decision: the
// committed output IS the decision — "Final output" lands (always, whether the human edited
// it or confirmed verbatim), which both drops the row from the queue and lets `reviewOf`
// derive agreement (committed ≡ Output). The pipeline move is the Prompt's to declare, not
// ours — its `resolve(committed)` names the Lead's next Status; an unknown prompt writes the
// output but moves nothing (loud, so a config gap can't silently strand a Lead). Idempotent:
// re-deciding overwrites. Needs "Update content" on BOTH the Decisions and Leads databases.
export const record = async (
	pageId: string,
	{
		committedOutput,
		feedback,
		finalReasoning
	}: { committedOutput?: unknown; feedback: string; finalReasoning?: string }
) => {
	const learning = {
		...(feedback ? { Feedback: { rich_text: chunks(feedback) } } : {}),
		...(finalReasoning ? { "Final reasoning": { rich_text: chunks(finalReasoning) } } : {})
	};
	if (committedOutput === undefined) {
		if (Object.keys(learning).length) await patch(pageId, learning); // a Save — decision withheld
		return;
	}

	const { properties } = await page(pageId);
	const promptId = relation(properties.Prompt)[0];
	const spec = promptId ? specByName((await promptInfo(promptId)).name) : undefined;
	// Resolve BEFORE the write so a malformed output fails loud, persisting nothing.
	const status = spec?.resolve(committedOutput as Record<string, unknown>).status;
	await patch(pageId, {
		...learning,
		"Final output": { rich_text: chunks(JSON.stringify(committedOutput)) }
	});
	if (status === undefined) {
		console.error(`record: no prompt spec for ${promptId} — Final output written, Lead not moved`);
		return;
	}
	await Promise.all(
		relation(properties.Lead).map((id) => patch(id, { Status: { select: { name: status } } }))
	);
};
