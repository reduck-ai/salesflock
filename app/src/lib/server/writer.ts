// The Writer's storage — long-form docs living as pages of one Notion data source
// (NOTION_WRITER_DS, "Content to post"): the row carries the metadata (Name, Status), the page BODY
// carries the prose. Prose is authored, not compiled (README #5) — so the body is the document, and
// markdown is the editing format both ways.
//
// Reuses the review app's own wire seam (server/notion.ts exports API/headers/page/patch) and the
// shared codec ($core/stores/notion.codec: bodyOf to read, chunks to write) rather than restating
// either. What is genuinely new is only the WRITE DIRECTION: Notion has no "replace body" call we can
// use (see `save` for the one that exists and why it is refused), so a save wipes the page's children
// and appends the draft again. The Writer owns the body.
//
// Both directions are the codec's: `bodyOf` renders a page to markdown, `blocksOf` turns the edited
// markdown back into blocks. Neither lives here, so a read and a write can never disagree about what
// a heading or a list is — and both are OURS, so a save writes back the author's exact words.

import { env } from "$env/dynamic/private";
import { API, headers, page, patch } from "./notion";
import { blocksOf, bodyOf, chunks, plain, type BlockPage, type NotionValue } from "$core/stores/notion.codec";

const ds = (): string => {
	if (!env.NOTION_WRITER_DS) throw new Error("NOTION_WRITER_DS is not set");
	return env.NOTION_WRITER_DS;
};

// One doc as the LIST needs it. `preview` is the opening prose: the list's real identity, because a
// title is optional in this database (rows genuinely exist with an empty Name) — a row you cannot
// recognize is a row you cannot pick.
export interface DocRow {
	id: string;
	title: string;
	status: string;
	edited: string; // last_edited_time (ISO) — the list's sort key and its "last saved" stamp
	preview: string;
}

export interface Doc {
	id: string;
	url: string;
	title: string;
	status: string;
	edited: string;
	markdown: string; // the page body — what the editor loads and saves back
}

const api = async <T>(path: string, init?: { method?: string; body?: object }): Promise<T> => {
	const res = await fetch(`${API}${path}`, {
		method: init?.method ?? (init?.body ? "POST" : "GET"),
		headers,
		body: init?.body ? JSON.stringify(init.body) : undefined
	});
	if (!res.ok) throw new Error(`Notion ${res.status} ${init?.method ?? "GET"} ${path}: ${await res.text()}`);
	return res.json() as Promise<T>;
};

const titleOf = (properties: Record<string, NotionValue>): string =>
	String(
		Object.values(properties)
			.filter((p) => p.type === "title")
			.map(plain)[0] ?? ""
	);
const statusOf = (properties: Record<string, NotionValue>): string =>
	String(properties.Status ? (plain(properties.Status) ?? "") : "");

// The blocks transport bodyOf needs (paging is the codec's decision, the fetch is ours).
const children = (blockId: string, cursor?: string): Promise<BlockPage> =>
	api<BlockPage>(`/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);

// The list preview — one SHALLOW call (the first few blocks), never bodyOf: a list of 50 docs must not
// fetch 50 whole documents to show 160 characters of each. Lossy by construction, which is why it
// does its own flattening rather than going through the codec's document rendering.
const PREVIEW = 180;
const previewOf = async (id: string): Promise<string> => {
	const { results } = await api<BlockPage>(`/blocks/${id}/children?page_size=3`);
	const text = results
		.map((b) => {
			const runs = (b[b.type] as { rich_text?: { plain_text: string }[] } | undefined)?.rich_text ?? [];
			return runs.map((r) => r.plain_text).join("");
		})
		.filter((s) => s.trim())
		.join(" ");
	return text.length > PREVIEW ? `${text.slice(0, PREVIEW).trimEnd()}…` : text;
};

// docs() — every doc, newest edit first, each with the preview that makes it recognizable. Paged to
// exhaustion (a growing archive must not silently cap at 100), previews fetched in one flight.
// Status FILTERING is the page's, over these rows: they are already in hand, so a server round-trip
// per tab would buy nothing — the same reasoning `decisions()` applies to its own in-code filters.
export const docs = async (): Promise<DocRow[]> => {
	const results: { id: string; last_edited_time: string; properties: Record<string, NotionValue> }[] = [];
	for (let cursor: string | undefined; ; ) {
		const p = await api<{
			results: typeof results;
			has_more: boolean;
			next_cursor: string | null;
		}>(`/data_sources/${ds()}/query`, {
			body: {
				sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
				...(cursor ? { start_cursor: cursor } : {})
			}
		});
		results.push(...p.results);
		if (!p.has_more || !p.next_cursor) break;
		cursor = p.next_cursor;
	}
	return Promise.all(
		results.map(async (r) => ({
			id: r.id,
			title: titleOf(r.properties),
			status: statusOf(r.properties),
			edited: r.last_edited_time,
			preview: await previewOf(r.id)
		}))
	);
};

// doc(id) — one document: its metadata and its body as markdown (the codec's rendering, so a Writer
// read and a judge's prompt read can never differ).
export const doc = async (id: string): Promise<Doc> => {
	const p = await page(id);
	return {
		id: p.id,
		url: p.url,
		title: titleOf(p.properties),
		status: statusOf(p.properties),
		edited: p.last_edited_time,
		markdown: await bodyOf(id, children)
	};
};

const APPEND_CAP = 100; // Notion accepts at most 100 children per append

// Every top-level block id of a page — PAGED to exhaustion, because a partial wipe is worse than no
// wipe: the leftovers would trail the freshly appended draft as duplicated prose.
const childIds = async (id: string): Promise<string[]> => {
	const ids: string[] = [];
	for (let cursor: string | undefined; ; ) {
		const p = await children(id, cursor);
		ids.push(...p.results.map((b) => b.id));
		if (!p.has_more || !p.next_cursor) break;
		cursor = p.next_cursor;
	}
	return ids;
};

// save(id, {title, markdown}) — the whole document as the editor has it. `title` is OPTIONAL and
// absence means "leave the Name alone", not "clear it": a rich_text/title column stays stale unless
// written, so writing `""` for an omitted title would silently destroy the row's name — which is
// exactly what a body-only writer (`sflock docs push`) would do. The editor always sends both.
//
// There is no replace-body call, so a save appends the new blocks and removes the old ones. The ORDER of those two is the
// whole safety property: append FIRST, delete second. Deleting first is what a "wipe and rewrite"
// reads like, but it makes every failure between the two destructive — measured: one rejected block
// (an invalid code language) left the page with zero blocks and the prose only still in the browser.
// This way a failed append has removed nothing, and the worst case is a page that briefly shows the
// old content followed by the new — visible and recoverable, never empty.
//
// Appends go in ≤100 batches, sequentially: Notion appends at the end, so a later batch must land
// after an earlier one. The title write is independent and rides along with the deletes.
//
// NOT `PATCH /v1/pages/{id}/markdown` (`{type:"replace_content"}`), which would make this ONE atomic
// request instead of ~2n and delete the ordering rule above. Rejected on measurement, and the reason is
// specific: Notion's markdown PARSER autoformats, so it does not write back what the author wrote. A
// bare domain in the prose returns as a link — "reduck.ai" → "[reduck.ai](http://reduck.ai/)", three
// times in one real draft — so every autosave would silently rewrite the writer's own words, and the
// set of other autoformats is unknown. `blocksOf` builds exactly the blocks it is given. (The
// endpoint's READ direction is faithful and its write is byte-identical to `blocksOf` on markdown with
// no bare domains — which is why a synthetic sample passes and real prose does not.)
export const save = async (id: string, { title, markdown }: { title?: string; markdown: string }): Promise<void> => {
	const stale = await childIds(id);
	const blocks = blocksOf(markdown);
	for (let i = 0; i < blocks.length; i += APPEND_CAP)
		await api(`/blocks/${id}/children`, { method: "PATCH", body: { children: blocks.slice(i, i + APPEND_CAP) } });
	await Promise.all([
		...(title === undefined ? [] : [patch(id, { Name: { title: chunks(title) } })]),
		...stale.map((blockId) => api(`/blocks/${blockId}`, { method: "DELETE" }))
	]);
};

// create(title) — a new, empty doc at the database's own first stage. Returns its id: the caller's
// next move is to open it.
export const create = async (title = ""): Promise<string> => {
	const { id } = await api<{ id: string }>("/pages", {
		body: {
			parent: { type: "data_source_id", data_source_id: ds() },
			properties: { Name: { title: chunks(title) }, Status: { status: { name: "Draft" } } }
		}
	});
	return id;
};
