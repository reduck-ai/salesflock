// Notion access for the review gate: one query for the pending queue, one write per committed
// decision. Schema-agnostic on purpose — a fork points NOTION_DECISIONS_DS at its own database
// and the page still renders. The one agent-specific input is `config.prompts` (via $agent): a
// prompt's `resolve` maps a committed output → its pipeline move + polarity, shared with the
// runtime. NOTION_TOKEN is an internal-integration token the databases are shared with.

import { error } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import { bodyOf, chunks, plain, relation, type BlockPage, type NotionValue } from "$core/stores/notion.codec";
import { schemaError } from "$core/output";
import { hasFeedback } from "$core/review";
import config from "$agent/config";
import type { Filter } from "$lib/filter";

const API = "https://api.notion.com/v1";
const headers = {
	Authorization: `Bearer ${env.NOTION_TOKEN}`,
	"Notion-Version": "2025-09-03",
	"Content-Type": "application/json"
};

export interface Decision {
	id: string;
	url: string;
	created: string; // the page's created_time (ISO) — the list's Date sort + row timestamp
	title: string;
	fields: Record<string, string>;
	deps: string[]; // upstream Decision ids ("Depends on") — the DAG edges
	// The Decision held behind this one — Notion's SYNCED inverse of "Depends on" (the property pair
	// is one relation, so downstream is a read direction, not a second stored fact). This is how a
	// confirmed gate knows which decision it just unlocked, and it rides on the page itself, so a
	// deep-linked card knows it too. Chains are linear in every agent today, hence one id, not a list.
	unlocks?: string;
	prompt?: string; // the Prompt page id — its Output schema governs the editable output
	promptName?: string; // the Prompt's Name (the row's kind) — the per-Prompt filter + sort key
	outputSchema?: Record<string, unknown>; // the Prompt's Output JSON Schema (the edit contract)
	proposal?: string; // the Prompt's framing text — what the output proposes (the card's header)
	anchorField?: string; // the Input field the composer attaches below (set ⇒ attached; unset ⇒ floating)
	system?: string; // the Prompt page's BODY — the instructions, grounding the autocomplete as they ground the judge
}

// A Prompt page → its Name, Output JSON Schema (the contract the human's output obeys), and
// its framing text ("Proposal") — proposal-oriented copy the card heads the output with. All
// optional: a fork's Prompt need not carry them, so each stays fail-soft.
//
// Memoized by page id: a Prompt page's content is immutable by id (a new version is a new row), and
// many Decisions share one prompt — so without this, decision()/decisions() re-fetch the SAME Prompt
// page once per card. Safe to share process-wide (not user-specific).
type PromptInfo = {
	name: string;
	outputSchema?: Record<string, unknown>;
	proposal?: string;
	anchorField?: string;
};
const promptInfoCache = new Map<string, PromptInfo>();
const promptInfo = async (id: string): Promise<PromptInfo> => {
	const cached = promptInfoCache.get(id);
	if (cached) return cached;
	const { properties } = await page(id);
	const name = String(
		Object.values(properties)
			.filter((p) => p.type === "title")
			.map(plain)[0] ?? ""
	);
	const schema = plain(properties["Output schema"]);
	const proposal = plain(properties["Proposal"]);
	const anchorField = plain(properties["Anchor field"]);
	const info: PromptInfo = {
		name,
		outputSchema: schema ? (JSON.parse(String(schema)) as Record<string, unknown>) : undefined,
		proposal: proposal ? String(proposal) : undefined,
		anchorField: anchorField ? String(anchorField) : undefined
	};
	promptInfoCache.set(id, info);
	return info;
};

// A Prompt page's BODY — its instructions, the grounding the autocomplete shares with the judge.
// Its own (memoized) fetch, deliberately apart from promptInfo: only the card path needs it, so the
// list never pays for a body it won't ground anything with. Paging + rendering are $core's codec.
//
// Fail-SOFT, unlike the judge's read of the same body (decide.ts throws on an empty one). The split
// is the stake: a judgment without instructions is invalid, but here the body only sharpens a ghost-
// text suggestion — so an unreadable one must never cost the reviewer their card. Surfaced on stderr,
// never swallowed silently, and the miss is not cached (a transient 5xx retries on the next open).
const promptBodyCache = new Map<string, string>();
const promptBody = async (id: string): Promise<string | undefined> => {
	const cached = promptBodyCache.get(id);
	if (cached !== undefined) return cached;
	try {
		const md = await bodyOf(id, async (blockId, cursor) => {
			const query = `page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`;
			const res = await fetch(`${API}/blocks/${blockId}/children?${query}`, { headers });
			if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
			return res.json() as Promise<BlockPage>;
		});
		promptBodyCache.set(id, md);
		return md;
	} catch (e) {
		console.error(`promptBody: prompt ${id} body unreadable — autocomplete ungrounded: ${(e as Error).message}`);
		return undefined;
	}
};

// The prompt's pipeline semantics, by its Name — the same `resolve` the runtime declares.
const specByName = (name: string) => Object.values(config.prompts ?? {}).find((s) => s.name === name);

// advanced(id) — has this Decision advanced the pipeline? The ONE reading of a DAG edge: its
// committed output run through its Prompt's `resolve`. Read by BOTH consumers, so the invariant does
// not depend on which path a reviewer took — the queue hides a blocked dependent (decisions), and
// the write refuses to commit one (record). Unreviewed, unknown-prompt or malformed ⇒ not advanced.
const advanced = async (id: string): Promise<boolean> => {
	const { properties } = await page(id);
	const fo = plain(properties["Final output"]);
	const promptId = relation(properties.Prompt)[0];
	if (!fo || !promptId) return false;
	const spec = specByName((await promptInfo(promptId)).name);
	try {
		return !!spec && spec.resolve(JSON.parse(String(fo)) as Record<string, unknown>).advances;
	} catch {
		return false;
	}
};

// ahead(to, from) — is `to` further along the agent's declared forward ladder than where the entity
// stands? An unknown ladder or an unreadable current status has nothing to compare, so it defers to
// the write. This is what keeps two decisions tied to ONE entity from fighting over its Status.
// (widened once here: the agent declares its ladder `as const`, so its indexOf would only accept its
// own literals — while a Status read back off a page is just a string.)
const ahead = (to: string, from: string | null): boolean => {
	const ladder: readonly string[] | undefined = config.ladder;
	return !ladder || from === null || ladder.indexOf(to) > ladder.indexOf(from);
};

const statusOf = async (id: string): Promise<string | null> => {
	const v = (await page(id)).properties.Status;
	return v ? (plain(v) as string | null) : null;
};

const page = async (
	id: string
): Promise<{ id: string; url: string; created_time: string; properties: Record<string, NotionValue> }> => {
	const res = await fetch(`${API}/pages/${id}`, { headers });
	if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
	return res.json();
};

// One page → a Decision: its title, its writable scalars flattened, and its "Depends on"
// edges. The one mapping, shared by the queue (decisions) and the deep link (decision).
const toDecision = ({
	id,
	url,
	created_time,
	properties
}: {
	id: string;
	url: string;
	created_time: string;
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
		created: created_time,
		title,
		fields,
		deps: relation(properties["Depends on"]),
		unlocks: relation(properties["Unlocks"])[0],
		prompt: relation(properties.Prompt)[0]
	};
};

// decision(id) — one Decision by id, for a deep link. No gate: a link opens its decision
// whatever its state (decided or blocked); the DAG gate governs only the queue's ordering.
export const decision = async (id: string): Promise<Decision> => {
	const d = toDecision(await page(id));
	if (d.prompt) {
		const info = await promptInfo(d.prompt);
		d.outputSchema = info.outputSchema;
		d.proposal = info.proposal;
		d.anchorField = info.anchorField;
		d.promptName = info.name;
		d.system = await promptBody(d.prompt);
	}
	return d;
};

// The review working set for a Filter, ordered — the ONE query both the list and the deck consume
// (the list maps it to summary rows, the deck uses it as the prev/next rail). Only `tab` is the
// server-side Notion cut (pending vs decided); prompt / feedback / sort are applied in code below,
// over fields already fetched (so `feedback` can mean hasFeedback's exhaustive 3-column sense, which
// no native filter expresses). Paginated — a growing Past tab must not be silently capped at 100.
export const decisions = async (filter: Filter): Promise<Decision[]> => {
	// pending: unset "Final output" (the committed output IS the decision). past: the decided log.
	const tabFilter = {
		property: "Final output",
		rich_text: filter.tab === "past" ? { is_not_empty: true } : { is_empty: true }
	};
	const results: { id: string; url: string; created_time: string; properties: Record<string, NotionValue> }[] = [];
	let cursor: string | undefined;
	do {
		const res = await fetch(`${API}/data_sources/${env.NOTION_DECISIONS_DS}/query`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				filter: tabFilter,
				sorts: [{ timestamp: "created_time", direction: "descending" }],
				...(cursor ? { start_cursor: cursor } : {})
			})
		});
		if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
		const page = (await res.json()) as {
			results: typeof results;
			has_more: boolean;
			next_cursor: string | null;
		};
		results.push(...page.results);
		cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
	} while (cursor);
	const rows = results.map(toDecision);

	// The editable output's contract + framing text + Name (the kind): each row's Prompt info (deduped).
	const infos = new Map(
		await Promise.all(
			[...new Set(rows.map((r) => r.prompt).filter((p): p is string => !!p))].map(
				async (id) => [id, await promptInfo(id)] as const
			)
		)
	);
	for (const r of rows) {
		const info = r.prompt && infos.get(r.prompt);
		if (info) {
			r.outputSchema = info.outputSchema;
			r.proposal = info.proposal;
			r.anchorField = info.anchorField;
			r.promptName = info.name;
		}
	}

	// The DAG gate, derived at read time — never stored: a Decision is reviewable only once every
	// upstream it depends on has *advanced* the pipeline. Only the review tab gates: past rows are a
	// log of decisions already made (they were gated when reviewed), so the gate would be moot there.
	let gated = rows;
	if (filter.tab === "review") {
		// A dep that is ITSELF in this pending set has no "Final output" — that is what made it
		// pending — and `advanced` is false for exactly that reason. So its answer is already in hand:
		// fetching the page to learn it is provably wasted work. Which is the common case (a fresh
		// chain has both stages pending), so this leaves a fetch only for a dep already committed —
		// mid-chain and orphaned rows. Same semantics, minus the round trips.
		const pending = new Set(rows.map((r) => r.id));
		const depIds = [...new Set(rows.flatMap((r) => r.deps))].filter((id) => !pending.has(id));
		const advances = new Map(
			await Promise.all(depIds.map(async (id) => [id, await advanced(id)] as const))
		);
		gated = rows.filter((r) => r.deps.every((d) => advances.get(d)));
	}

	// prompt / feedback in code (over fields already fetched), then sort. Date is created desc;
	// Prompt groups by Name, created desc within a group. Both stable — a re-query reads the same.
	let out = gated;
	if (filter.prompt !== "all") out = out.filter((r) => r.promptName === filter.prompt);
	if (filter.feedback !== "any") {
		const want = filter.feedback === "has";
		out = out.filter((r) => hasFeedback(r.fields) === want);
	}
	return out
		.slice()
		.sort(
			filter.sort === "prompt"
				? (a, b) =>
						(a.promptName ?? "").localeCompare(b.promptName ?? "") || b.created.localeCompare(a.created)
				: (a, b) => b.created.localeCompare(a.created)
		);
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
//
// Returns whether the committed outcome ADVANCED the pipeline — the one thing the caller can't
// derive: `advances` is the agent's semantics (config.prompts[k].resolve), and the deck needs it to
// decide whether to open the decision this one unlocks. A rejecting outcome invalidates its
// dependent, so the answer must come from here rather than be re-guessed client-side.
export const record = async (
	pageId: string,
	{
		committedOutput,
		feedback,
		finalReasoning
	}: { committedOutput?: unknown; feedback: string; finalReasoning?: string }
): Promise<{ advances: boolean }> => {
	// The learning channel is a full snapshot of the human's live draft, not a sparse patch:
	// both columns always land as exactly what the human has — empty included, which CLEARS the
	// column (a rich_text stays stale unless you write it). So reverting a note to nothing
	// persists, where omitting the key would leave the old value untouched.
	const learning = {
		Feedback: { rich_text: chunks(feedback) },
		"Final reasoning": { rich_text: chunks(finalReasoning ?? "") }
	};
	if (committedOutput === undefined) {
		await patch(pageId, learning); // a Save — decision withheld, draft snapshotted
		return { advances: false }; // nothing was decided, so nothing was unlocked
	}

	const { properties } = await page(pageId);
	const promptId = relation(properties.Prompt)[0];
	const { name, outputSchema } = promptId
		? await promptInfo(promptId)
		: { name: "", outputSchema: undefined };
	// The same gate the LLM passes: a committed output that violates its Prompt schema is refused
	// (defense behind the client's own check) — nothing is persisted.
	const invalid = outputSchema && schemaError(outputSchema, committedOutput);
	if (invalid) throw error(400, `output violates Output schema: ${invalid}`);
	// The DAG gate, enforced where the MUTATION happens — not only in the query that builds the queue.
	// A deep link, a bookmark, a preloaded neighbour and a stale rail step all reach this endpoint, so
	// a dependent must be refused HERE or it can be committed (and move the entity) before the
	// decision it hangs off has been approved. Same `advanced` reading the queue's gate uses.
	const blocked = (await Promise.all(relation(properties["Depends on"]).map(advanced))).some((ok) => !ok);
	if (blocked)
		throw error(409, "blocked: the decision this one depends on has not been approved yet");
	const spec = specByName(name);
	// Resolve BEFORE the write so a malformed output fails loud, persisting nothing.
	const move = spec?.resolve(committedOutput as Record<string, unknown>);
	await patch(pageId, {
		...learning,
		"Final output": { rich_text: chunks(JSON.stringify(committedOutput)) }
	});
	if (move === undefined) {
		console.error(`record: no prompt spec for ${promptId} — Final output written, entity not moved`);
		return { advances: false };
	}
	// Move whichever pipeline entity this agent binds a Decision to — the relation `$agent` names
	// (config.entity: "Lead" | "X Engagement"), not a hardcoded one. A committed decision with no
	// such relation is an anomaly, so it's surfaced loud (the row still advanced no entity).
	const entityIds = relation(properties[config.entity]);
	if (!entityIds.length) {
		console.error(`record: decision ${pageId} has no "${config.entity}" relation — Final output written, entity not moved`);
		return { advances: move.advances };
	}
	// Two decisions can be tied to ONE entity (a qualification and the draft held behind it), so an
	// unconditional write is "last confirm wins" — enough to drag the entity BACKWARD (confirm the
	// draft, then its qualification, and Approved becomes To engage). An ADVANCING outcome may only
	// move the entity forward along the ladder the agent declares — the same ladder its runtime stages
	// obey. A non-advancing one is the human's terminal reject and always lands: that is the one move
	// which is legitimately not forward.
	await Promise.all(
		entityIds.map(async (id) => {
			if (move.advances && !ahead(move.status, await statusOf(id))) return;
			await patch(id, { Status: { select: { name: move.status } } });
		})
	);
	return { advances: move.advances };
};
