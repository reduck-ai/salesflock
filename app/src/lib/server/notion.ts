// Notion access for the review gate: one query for the pending queue, one write per committed
// decision. Schema-agnostic on purpose — a fork points NOTION_DECISIONS_DS at its own database
// and the page still renders. The one agent-specific input is resolved PER ROW via the roster
// ($agents/index): a decision's kind names the agent that judged it, whose prompt `resolve` maps
// a committed output → its pipeline move + polarity, and whose `entity`/`ladder` govern the move —
// shared with the runtime. NOTION_TOKEN is an internal-integration token the databases are shared with.

import { error } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import { chunks, plain, relation, type NotionValue } from "$core/stores/notion.codec";
import { schemaError } from "$core/output";
import { hasFeedback, SAID } from "$core/review";
import { agentFor } from "$agents/index";
import { promptFor } from "$lib/server/prompts";
import type { Filter } from "$lib/filter";

// The wire seam — exported because the Writer's own client (server/writer.ts) speaks to a DIFFERENT
// data source with the SAME token and version pinning. Sharing the constants beats a second copy
// drifting a Notion-Version behind.
export const API = "https://api.notion.com/v1";
export const headers = {
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
	promptName?: string; // the row's KIND — the per-Prompt filter + sort key, and what resolves the rest
	outputSchema?: Record<string, unknown>; // the prompt's Output JSON Schema (the edit contract)
	anchorField?: string; // the Input field the composer attaches below (set ⇒ attached; unset ⇒ floating)
	system?: string; // the prompt's instructions — grounding the autocomplete as they ground the judge
}

// contractOf(kind) — everything a card needs about the judgment that produced it, from the LOCAL
// prompt tree (server/prompts.ts) plus the roster. This used to be two memoized Notion reads per
// distinct prompt (its properties, then its body); the contract is a file now, so it is a lookup.
const contractOf = (kind?: string): Pick<Decision, "outputSchema" | "anchorField" | "system"> => ({
	outputSchema: promptFor(kind)?.outputSchema,
	anchorField: agentFor(kind)?.spec.anchor,
	system: promptFor(kind)?.system
});

// advanced(id) — has this Decision advanced the pipeline? The ONE reading of a DAG edge: its
// committed output run through its Prompt's `resolve`. Read by BOTH consumers, so the invariant does
// not depend on which path a reviewer took — the queue hides a blocked dependent (decisions), and
// the write refuses to commit one (record). Unreviewed, unknown-prompt or malformed ⇒ not advanced.
// `created` rides along because the same fetch yields the CHAIN sort key: a dependent sorts at its
// gate's created time, so once the gate is confirmed the dependent appears at the very slot it held.
const advanced = async (id: string): Promise<{ advances: boolean; created: string }> => {
	const { properties, created_time: created } = await page(id);
	const fo = plain(properties["Final output"]);
	const kind = plain(properties.Kind);
	if (!fo || !kind) return { advances: false, created };
	const spec = agentFor(String(kind))?.spec;
	try {
		return {
			// No `resolve` ⇒ the prompt moves no pipeline (an offline scorer), so it advances nothing —
			// the same answer as an unknown prompt, and for the same reason: there is no rule to read.
			advances: !!spec?.resolve?.(JSON.parse(String(fo)) as Record<string, unknown>).advances,
			created
		};
	} catch {
		return { advances: false, created };
	}
};

// ahead(to, from, ladder) — is `to` further along the owning agent's declared forward ladder than
// where the entity stands? An unknown ladder or an unreadable current status has nothing to compare,
// so it defers to the write. This is what keeps two decisions tied to ONE entity from fighting over
// its Status. (widened once here: the agent declares its ladder `as const`, so its indexOf would
// only accept its own literals — while a Status read back off a page is just a string.)
const ahead = (to: string, from: string | null, ladder?: readonly string[]): boolean =>
	!ladder || from === null || ladder.indexOf(to) > ladder.indexOf(from);

// A ROW IS PENDING IFF THE HUMAN HAS SAID NOTHING — compiled from the ONE declaration of which
// columns a verdict lands in ($core/review `SAID`, shared with the operator CLI's own queue, so the
// two cannot name different sets). A committed output is a Confirm: it was posted. A NOTE is a
// rejection: it was not, and it stays as the rule `sflock learn` moves into the corpus.
const said = (yes: boolean) =>
	SAID.map((property) => ({ property, rich_text: { [yes ? "is_not_empty" : "is_empty"]: true } }));

const statusOf = async (id: string): Promise<string | null> => {
	const v = (await page(id)).properties.Status;
	return v ? (plain(v) as string | null) : null;
};

// The pipeline entity's own row, read ONCE and used twice: flattened to plain scalars for the
// agent's `act` to read (has my effect already happened? where do I aim it?), and kept as live
// property types so whatever the act hands back can be written without anyone declaring a shape.
// The flattening is the runtime store's, so both sides see one row the same way.
const entityOf = async (
	id: string
): Promise<{ fields: Record<string, string>; types: Record<string, string> }> => {
	const { properties } = await page(id);
	const fields: Record<string, string> = {};
	const types: Record<string, string> = {};
	for (const [name, v] of Object.entries(properties)) {
		types[name] = v.type;
		const s = plain(v);
		if (s != null && s !== "") fields[name] = String(s);
	}
	return { fields, types };
};

// An act's plain result → the API's write payload, against the row's OWN live property types. The
// agent returns values, never Notion shapes: `act` is a business rule (post this, and here is the
// permalink), and a config that had to spell `{ url: … }` would be declaring the store's dialect
// instead. Loud on a property the entity does not have, or one this cannot write — a silently
// dropped record of a deed already done is the one outcome worth refusing.
const propertiesOf = (
	done: Record<string, unknown>,
	types: Record<string, string>
): Record<string, unknown> =>
	Object.fromEntries(
		Object.entries(done).map(([name, value]) => {
			const type = types[name];
			if (!type) throw new Error(`act returned "${name}", which the entity has no property for`);
			switch (type) {
				case "url":
				case "email":
				case "phone_number":
				case "number":
				case "checkbox":
					return [name, { [type]: value }];
				case "date":
					return [name, { date: { start: String(value) } }];
				case "select":
				case "status":
					return [name, { [type]: { name: String(value) } }];
				case "rich_text":
				case "title":
					return [name, { [type]: chunks(String(value)) }];
				default:
					throw new Error(`act returned "${name}", a "${type}" this cannot write`);
			}
		})
	);

export const page = async (
	id: string
): Promise<{
	id: string;
	url: string;
	created_time: string;
	last_edited_time: string;
	properties: Record<string, NotionValue>;
}> => {
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
	const promptName = fields.Kind || undefined;
	return {
		id,
		url,
		created: created_time,
		title,
		fields,
		deps: relation(properties["Depends on"]),
		promptName,
		...contractOf(promptName)
	};
};

// decision(id) — one Decision by id, for a deep link. No gate: a link opens its decision
// whatever its state (decided or blocked); the DAG gate governs only the queue's ordering.
export const decision = async (id: string): Promise<Decision> => toDecision(await page(id));

// The review working set for a Filter, ordered — the ONE query both the list and the deck consume
// (the list maps it to summary rows, the deck uses it as the prev/next rail). Only `tab` is the
// server-side Notion cut (pending vs decided); prompt / feedback / sort are applied in code below,
// over fields already fetched (so `feedback` can mean hasFeedback's exhaustive 3-column sense, which
// no native filter expresses). Paginated — a growing Past tab must not be silently capped at 100.
export const decisions = async (filter: Filter): Promise<Decision[]> => {
	// A ROW IS PENDING IFF THE HUMAN HAS SAID NOTHING, and there are two ways to say something —
	// which column carries it is what says which way it went. A committed output is a Confirm (it
	// was posted); a NOTE is a rejection (it was not). That second clause is the whole of the reject
	// flow's read side: `record` derives the same fact from the same emptiness, so the queue and the
	// write can never disagree about what a note means.
	const tabFilter = filter.tab === "past" ? { or: said(true) } : { and: said(false) };
	const results: {
		id: string;
		url: string;
		created_time: string;
		properties: Record<string, NotionValue>;
	}[] = [];
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
	// Each row arrives whole: `toDecision` resolves its contract from the local prompt tree, so the
	// list no longer fans out a Prompt read per distinct kind before it can render.
	const rows = results.map(toDecision);

	// The DAG gate, derived at read time — never stored: a Decision is reviewable only once every
	// upstream it depends on has *advanced* the pipeline. Only the review tab gates: past rows are a
	// log of decisions already made (they were gated when reviewed), so the gate would be moot there.
	let gated = rows;
	// The chain key: a dependent sorts at its GATE's created time, not its own. That single fact is
	// the whole sequencing — the gate and its dependent never co-exist in the queue (pending gate ⇒
	// dependent hidden), so confirming the gate makes the dependent surface at the exact slot the
	// gate vacated: refreshing the rail IS advancing to the follow-up. No stored order, no jump.
	const chainKey = new Map<string, string>();
	if (filter.tab === "review") {
		// A dep that is ITSELF in this pending set has no "Final output" — that is what made it
		// pending — and `advanced` is false for exactly that reason. So its answer is already in hand:
		// fetching the page to learn it is provably wasted work. Which is the common case (a fresh
		// chain has both stages pending), so this leaves a fetch only for a dep already committed —
		// mid-chain and orphaned rows. Same semantics, minus the round trips.
		const pending = new Set(rows.map((r) => r.id));
		const depIds = [...new Set(rows.flatMap((r) => r.deps))].filter((id) => !pending.has(id));
		const gates = new Map(await Promise.all(depIds.map(async (id) => [id, await advanced(id)] as const)));
		gated = rows.filter((r) => r.deps.every((d) => gates.get(d)?.advances));
		for (const r of gated) {
			const gate = r.deps.length ? gates.get(r.deps[0]) : undefined;
			if (gate) chainKey.set(r.id, gate.created);
		}
	}

	// prompt / feedback in code (over fields already fetched), then sort. Date is created desc
	// (chain-keyed, above); Prompt groups by Name, created desc within a group. Both stable — a
	// re-query reads the same.
	let out = gated;
	if (filter.prompt !== "all") out = out.filter((r) => r.promptName === filter.prompt);
	if (filter.feedback !== "any") {
		const want = filter.feedback === "has";
		out = out.filter((r) => hasFeedback(r.fields) === want);
	}
	const key = (r: Decision) => chainKey.get(r.id) ?? r.created;
	return out
		.slice()
		.sort(
			filter.sort === "prompt"
				? (a, b) => (a.promptName ?? "").localeCompare(b.promptName ?? "") || key(b).localeCompare(key(a))
				: (a, b) => key(b).localeCompare(key(a))
		);
};

export const patch = async (pageId: string, properties: Record<string, unknown>) => {
	const res = await fetch(`${API}/pages/${pageId}`, {
		method: "PATCH",
		headers,
		body: JSON.stringify({ properties })
	});
	if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
};

// archive(pageId) — remove a page (Notion's archive = delete-to-trash). Used for exactly one thing:
// a rejected gate's unreviewed dependents — eager work that no longer matters.
const archive = async (pageId: string) => {
	const res = await fetch(`${API}/pages/${pageId}`, {
		method: "PATCH",
		headers,
		body: JSON.stringify({ archived: true })
	});
	if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
};

// refuse(pageId) — close what a note refuses. The Decision row itself is left alone beyond the note:
// it is the audit trail, and `sflock learn` still needs its frozen evidence to cut a ground-truth
// case from (which is why this archives nothing — the app hands the row to the learn worklist,
// `sflock decisions list --feedback`, and that second stage retires it).
//
// So the only thing that moves is the pipeline entity the agent opened, through its own `drop`. Two
// properties make this safe to do from a click. It is REVERSIBLE: the note IS the queue marker, so
// clearing it puts the row back: and "Dropped" sits off the agent's `ladder`, so `ahead()` lets a
// later Confirm move the entity forward anyway. And it is IDEMPOTENT by the agent's own guard (it
// no-ops on a conversation already posted in), so `learn` calling it again later costs nothing.
const refuse = async (pageId: string): Promise<void> => {
	const { properties } = await page(pageId);
	const kind = String(plain(properties.Kind) ?? "");
	const subject = plain(properties.Subject);
	const drop = agentFor(kind)?.config.drop;
	// Loud, never silent: a note is recorded either way (it is already written), but an entity left
	// open at its pending rung with no decision on it is a row nobody will ever close.
	if (!drop || !subject)
		return void console.error(
			`refuse: decision ${pageId} noted but nothing closed — ${
				!subject ? "it carries no Subject" : `kind "${kind}" declares no \`drop\``
			}`
		);
	await drop(String(subject));
};

// record(pageId, { output, feedback, finalReasoning, commit }) — a review writes the human-owned
// columns. There is ONE thing to write and one bit that says what it means: the human's WORKING
// COPY — the output as they have it, their note, their statements ("Reasoning" stays the judge's,
// verbatim) — and whether they are deciding.
//
//   commit: false  a Save. The working copy lands in the three DRAFT columns and nothing else, so
//                  the row keeps its place in the queue and reopens exactly as they left it —
//                  UNLESS it carries a note, which is a rejection (`refuse` above). Three verdicts,
//                  still one payload and one bit: the note is not a mode, it is what was said.
//   commit: true   the decision. The same output lands in "Final output" — the sole marker of a
//                  review (its presence drops the row from the queue and lets `reviewOf` derive
//                  agreement, committed ≡ Output) — and the draft output is CLEARED, because the
//                  working copy has become the decision and two columns must never both claim to be
//                  the human's latest word.
//
// All of it is a full snapshot, never a sparse patch: every column lands as exactly what the human
// has, EMPTY INCLUDED, which clears it (a rich_text stays stale unless you write it). So reverting a
// note to nothing persists, where omitting the key would leave the old value untouched.
//
// The pipeline move is the Prompt's to declare, not ours — its `resolve(committed)` names the
// entity's next Status, and its `act` performs the deed; an unknown prompt writes the output but
// moves nothing (loud, so a config gap can't silently strand a row). Idempotent: re-deciding
// overwrites. Needs "Update content" on BOTH the Decisions and the entity databases.
//
// A NON-advancing outcome also archives the unreviewed dependents this decision holds back (read
// off "Unlocks", Notion's synced inverse of "Depends on"): they were drafted eagerly against a
// gate the human just rejected, carry no judgment of their own (the 409 below guarantees it), and
// their subject left the funnel — so they are deleted, not hidden forever. Append-only still holds
// for every JUDGED decision; this row itself stays as the audit trail. The caller learns nothing
// back: the rail's chain-keyed order already encodes what comes next.
export const record = async (
	pageId: string,
	{
		output,
		feedback,
		finalReasoning,
		commit
	}: { output: unknown; feedback: string; finalReasoning?: string; commit: boolean }
): Promise<void> => {
	const working = {
		Feedback: { rich_text: chunks(feedback) },
		"Final reasoning": { rich_text: chunks(finalReasoning ?? "") },
		// The third draft channel, and the reason it exists: without it a Save kept the human's note
		// and their reasoning edits but silently discarded the words they had actually rewritten — so
		// the only way to preserve an edited output was to COMMIT it, which is to say the only way to
		// keep your work was to decide. Now the three parts of a working copy are saved together.
		"Draft output": { rich_text: chunks(commit ? "" : JSON.stringify(output)) }
	};
	if (!commit) {
		await patch(pageId, working);
		// A NOTE IS A REJECTION, derived rather than declared: the caller sends the same working copy
		// and the same `commit: false`, and what the human wrote decides what it means. One predicate,
		// so the queue's read (`SAID.noted`) and this write cannot come to disagree — a client that had
		// to declare the intent could send a noted Save or a note-less Reject, and the rule would then
		// live in two places.
		//
		// Nothing was committed, so nothing is posted: no "Final output", no `act`, no `resolve`. What
		// moves is the pipeline entity, through the `drop` the agent already declares beside `act` as
		// the mirror of it — that is what approving DOES, this is what refusing does. Until now only
		// `sflock learn` could reach it, so the app could approve and never refuse.
		return void (feedback.trim() && (await refuse(pageId)));
	}
	const committedOutput = output;

	// The write runs in three waves — the calls were always independent, only the awaits serialized
	// them. Wave 1: the decision page (everything below hangs off its properties).
	const { properties } = await page(pageId);
	// The row's KIND is a column on the row itself, so the contract is in hand with no read at all —
	// leaving one thing for wave 2: the DAG deps' state. Every gate below is pure and runs BEFORE any
	// write.
	const name = String(plain(properties.Kind) ?? "");
	const { outputSchema } = contractOf(name);
	const deps = await Promise.all(relation(properties["Depends on"]).map(advanced));
	// The same gate the LLM passes: a committed output that violates its Prompt schema is refused
	// (defense behind the client's own check) — nothing is persisted.
	const invalid = outputSchema && schemaError(outputSchema, committedOutput);
	if (invalid) throw error(400, `output violates Output schema: ${invalid}`);
	// The DAG gate, enforced where the MUTATION happens — not only in the query that builds the queue.
	// A deep link, a bookmark, a preloaded neighbour and a stale rail step all reach this endpoint, so
	// a dependent must be refused HERE or it can be committed (and move the entity) before the
	// decision it hangs off has been approved. Same `advanced` reading the queue's gate uses.
	if (deps.some((d) => !d.advances))
		throw error(409, "blocked: the decision this one depends on has not been approved yet");
	// The row's own agent — its spec drives the move; its entity/ladder say what moves and which
	// way is forward. Resolve BEFORE the write so a malformed output fails loud, persisting nothing.
	const owner = agentFor(name);
	// `resolve?.` — a prompt may declare no pipeline effect at all (an offline scorer, which mints no
	// Decision and so should never reach here). Undefined lands in the same branch as an unknown
	// kind below: the output is still recorded, nothing is moved, and the anomaly is logged.
	const move = owner?.spec.resolve?.(committedOutput as Record<string, unknown>);

	// Wave 2b — the ACT: what committing this decision DOES outside the CRM (post the reply, send the
	// message), declared by the agent beside `resolve` because it is the same kind of business rule.
	// It runs HERE, between the last gate and the first write, for one reason: a decision a human
	// approves and a machine performs in a later pass has two truths and a window between them that
	// something has to model. Failing here throws, so nothing is persisted and the row simply stays
	// in the queue to be confirmed again — and the act's own idempotence (it reads the entity's
	// current fields) is what makes that retry safe.
	//
	// Its result is not a side note: it is the record of the deed (a permalink, a timestamp), and it
	// rides into the SAME patch as `resolve`'s Status below, so the doing and the saying-so cannot
	// come apart. One entity, so the act runs once even if the relation somehow held several.
	//
	// Its failure is re-raised as an HttpError, and that is not decoration: an ordinary throw reaches
	// the reviewer as "Internal Error" (SvelteKit hides internal messages in production), and the one
	// thing they need is WHY — the device was asleep, the subreddit refused the post. So the reason
	// travels, and the card comes back with the judgment untaken.
	const entityIds = owner ? relation(properties[owner.config.entity]) : [];
	const entity = owner?.spec.act && entityIds.length ? await entityOf(entityIds[0]) : undefined;
	const done = entity
		? await owner!.spec.act!(committedOutput as Record<string, unknown>, entity.fields).catch(
				(e: unknown) => {
					throw error(502, `not committed — the action failed: ${(e as Error).message}`);
				}
			)
		: null;

	// Wave 3: the writes, one flight — the commit itself, the rejecting gate's dependent archiving,
	// and the entity moves are mutually independent once the gates above have ruled.
	const decided = patch(pageId, {
		...working,
		"Final output": { rich_text: chunks(JSON.stringify(committedOutput)) }
	});
	if (move === undefined || owner === undefined) {
		await decided;
		return void console.error(
			`record: ${owner ? `kind "${name}" declares no \`resolve\` — it moves no pipeline and should not be reviewable` : `no agent declares kind "${name}"`} — Final output written, entity not moved`
		);
	}
	// A rejecting gate deletes the eager work it held back — each unreviewed dependent is archived.
	const archives = move.advances
		? []
		: relation(properties["Unlocks"]).map(async (depId) => {
				if (!plain((await page(depId)).properties["Final output"])) await archive(depId);
			});
	// Move whichever pipeline entity the OWNING agent binds a Decision to — the relation its config
	// names (entity: "Lead" | "Reddit Backlog"), not a hardcoded one. Two decisions can be tied to
	// ONE entity (a qualification and the draft held behind it), so an unconditional write is "last
	// confirm wins" — enough to drag the entity BACKWARD. An ADVANCING outcome may only move the
	// entity forward along the ladder that agent declares — the same ladder its runtime stages obey.
	// A non-advancing one is the human's terminal reject and always lands: the one move legitimately
	// not forward.
	//
	// The act's record rides in this same patch, and it is NOT subject to that guard: the Status is a
	// claim about where the row stands and may be refused, but a permalink is a fact about the world
	// that already happened. Refusing to write it would leave the deed done and unrecorded — so it
	// lands whether or not the move does, and it lands in ONE write, so they cannot come apart.
	const moves = entityIds.map(async (id) => {
		const stay = move.advances && !ahead(move.status, await statusOf(id), owner.config.ladder);
		const record = {
			...(done && entity ? propertiesOf(done, entity.types) : {}),
			...(stay ? {} : { Status: { select: { name: move.status } } })
		};
		if (Object.keys(record).length) await patch(id, record);
	});
	await Promise.all([decided, ...archives, ...moves]);
	// A committed decision with no entity relation is an anomaly — surfaced loud, never swallowed.
	if (!entityIds.length)
		console.error(
			`record: decision ${pageId} has no "${owner.config.entity}" relation — Final output written, entity not moved`
		);
};
