// Minimal Notion client — describes a Notion model (a database / data source) as a
// JSON Schema of its WRITABLE properties: exactly what a writer can set, enums and
// relation targets included. The semantic mapping (Notion property type → JSON Schema
// fragment) is the one Notion-specific thing here; the schema it emits is the uniform
// contract the generic layer compiles to TS.
//
// Auth: `ntn` owns login/refresh (its keychain session); we harvest its bearer ONCE per
// process — the harvest call itself makes ntn refresh, so the token is fresh by
// construction — then every request is direct HTTP (Node's pooled fetch; shelling ntn
// per call cost ~600ms of spawn + TLS each). We persist nothing: the token lives in
// process memory and dies with it. NOTION_TOKEN overrides (an *integration* identity,
// the review app's mode — it only sees databases explicitly shared with it, where the
// logged-in person sees the whole personal CRM). Same contract as hubspot.ts.

import { spawn } from "node:child_process";
import { bodyOf, chunks, plain, type BlockPage, type NotionValue } from "./notion.codec.js";
import { gate, NOTION_CONCURRENCY } from "../concurrency.js";
import { log } from "../log.js";
import type { Ref, Row, Store } from "./index.js";

// Spawn `ntn` capturing stderr (the verbose trace rides there) — only the token harvest uses it.
// stdin is closed ("ignore"): `ntn api` reads a request body from stdin, so an open empty pipe
// would hang it forever.
const spawnNtn = (args: string[]): Promise<string> =>
	new Promise((resolve, reject) => {
		const child = spawn("ntn", args, { stdio: ["ignore", "pipe", "pipe"] });
		let err = "";
		child.stderr.on("data", (d) => (err += d));
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0 ? resolve(err) : reject(new Error(`ntn ${args.join(" ")} → exit ${code}: ${err.trim()}`))
		);
	});

// The bearer, resolved once per process: NOTION_TOKEN if set, else harvested from ntn's own
// verbose trace of one cheap call (`--unsafe-verbose` un-redacts the Authorization header —
// a documented debugging flag; if a future ntn drops it, the error names both recovery paths).
let tok: Promise<string> | undefined;
const token = (): Promise<string> => (tok ??= resolveToken());
const resolveToken = async (): Promise<string> => {
	if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN;
	const trace = await spawnNtn(["--verbose", "--unsafe-verbose", "api", "/v1/users/me"]).catch((e: Error) => {
		throw new Error(`ntn: no session — run \`ntn login\` (or set NOTION_TOKEN). ${e.message}`);
	});
	const m = trace.match(/authorization: [Bb]earer (\S+)/);
	if (!m) throw new Error("ntn: could not read a token from `ntn --verbose --unsafe-verbose` — run `ntn login` (or set NOTION_TOKEN)");
	return m[1];
};

// One gate for the whole Notion backend (its own ceiling, so a tool can fan out wider than it), with
// retry-on-429: the API rate-limits as a long-window average, so a burst draws 429s — honor its
// Retry-After (fall back to exponential backoff) rather than fail the run. The retry is the sole
// diagnostic here (a slow, exceptional event → the one log seam); normal calls stay quiet, so stdout
// stays the answer and stderr only speaks when it matters.
const API = "https://api.notion.com/v1";
const slot = gate(NOTION_CONCURRENCY);
const api = <T>(path: string, init?: { method?: string; body?: object }): Promise<T> =>
	slot(async () => {
		for (let attempt = 0; ; attempt++) {
			const res = await fetch(API + path, {
				method: init?.method ?? (init?.body ? "POST" : "GET"),
				headers: {
					Authorization: `Bearer ${await token()}`,
					"Notion-Version": "2025-09-03",
					"Content-Type": "application/json"
				},
				body: init?.body ? JSON.stringify(init.body) : undefined
			});
			if (res.ok) return (await res.json()) as T;
			const text = await res.text();
			if (res.status !== 429 || attempt >= 4)
				throw new Error(`notion ${res.status} ${init?.method ?? "GET"} ${path}: ${text}`);
			const wait = Number(res.headers.get("retry-after")) * 1000 || 500 * 2 ** attempt;
			// A short throttle is retried; a long ban is surfaced. Notion's Retry-After can say minutes
			// (measured: 424s after a sustained burst) — sleeping that long turns a CLI into a silent
			// hang, so past the cap we fail loud with the ban's own duration instead.
			if (wait > 60_000)
				throw new Error(`notion 429 ${path}: rate-limited for ${Math.round(wait / 1000)}s — try again later`);
			log("notion", `rate-limited, retry ${attempt + 1}/4 in ${wait}ms`);
			await new Promise((r) => setTimeout(r, wait));
		}
	});

// A Notion data source, as the API returns it — only the fields we read.
interface DataSource {
	id: string;
	title: { plain_text: string }[];
	properties: Record<string, NotionProp>;
}
interface NotionProp {
	type: string;
	select?: { options: { name: string }[] };
	status?: { options: { name: string }[] };
	multi_select?: { options: { name: string }[] };
	relation?: { data_source_id?: string; database_id?: string };
}

// A bare 32-hex id out of a raw id or a Notion URL (a dashed uuid passes through — Notion's
// API accepts both). The one id extractor, shared by the store and any caller that resolves a
// user-pasted handle (an id, a Notion URL, an app URL) to a page.
export const idOf = (s: string): string => s.match(/[0-9a-f]{32}/i)?.[0] ?? s;

// Resolve a model handle (database id / data-source id / URL) to a data source id.
// `GET /databases/{id}` lists a DATABASE's data source(s); given a value that is already
// a data source id it 404s, so a failed lookup means "use it directly".
// Memoized: a model→dsId mapping is stable for the life of a (short-lived) CLI process.
const dsIdCache = new Map<string, string>();
const resolveDsId = async (model: string): Promise<string> => {
	const cached = dsIdCache.get(model);
	if (cached) return cached;
	const id = idOf(model);
	const db = await api<{ data_sources?: { id: string }[] }>(`/databases/${id}`).catch(() => null);
	const ids = db?.data_sources?.map((d) => d.id) ?? [];
	if (ids.length > 1)
		throw new Error(
			`"${model}" is a database with ${ids.length} data sources — pass one of: ${ids.join(", ")}`
		);
	const dsId = ids[0] ?? id;
	dsIdCache.set(model, dsId);
	return dsId;
};

// A data source's schema (its property map) — also stable per process, so fetch it once per id;
// the cache removes the repeated schema fetch every locate/describe made.
const dsCache = new Map<string, DataSource>();
const loadDs = async (dsId: string): Promise<DataSource> => {
	const hit = dsCache.get(dsId);
	if (hit) return hit;
	const ds = await api<DataSource>(`/data_sources/${dsId}`);
	dsCache.set(dsId, ds);
	return ds;
};

const optionNames = (o?: { options: { name: string }[] }): string[] =>
	(o?.options ?? []).map((x) => x.name);

// Notion property type → JSON Schema fragment. null for read-only types (formula,
// rollup, the audit *_time/*_by fields, files, button, unique_id, …): a writer can't
// set them, so they don't belong in the writable contract.
const fragment = (p: NotionProp): Record<string, unknown> | null => {
	switch (p.type) {
		case "title":
		case "rich_text":
			return { type: "string" };
		case "url":
			return { type: "string", format: "uri" };
		case "email":
			return { type: "string", format: "email" };
		case "phone_number":
			return { type: "string" };
		case "number":
			return { type: "number" };
		case "checkbox":
			return { type: "boolean" };
		case "date":
			return { type: "string", description: "ISO 8601 date or date-time" };
		case "select":
			return { type: "string", enum: optionNames(p.select) };
		case "status":
			return { type: "string", enum: optionNames(p.status) };
		case "multi_select":
			return { type: "array", items: { type: "string", enum: optionNames(p.multi_select) } };
		case "people":
			return { type: "array", items: { type: "string" }, description: "Notion user ids" };
		case "relation":
			return {
				type: "array",
				items: { type: "string" },
				description: `relation → ${p.relation?.data_source_id ?? p.relation?.database_id ?? "?"}`
			};
		default:
			return null; // read-only / unwritable
	}
};

// Inverse of fragment: a value + its Notion property type → the API write payload. Covers
// the writable scalar types; relation/people need id resolution, so we refuse them loudly
// rather than write a wrong shape silently.
const serialize = (value: unknown, p: NotionProp): Record<string, unknown> => {
	switch (p.type) {
		case "title":
		case "rich_text":
			return { [p.type]: chunks(String(value)) };
		case "url":
		case "email":
		case "phone_number":
		case "number":
		case "checkbox":
			return { [p.type]: value };
		case "date":
			return { date: { start: String(value) } };
		case "select":
		case "status":
			return { [p.type]: { name: String(value) } };
		case "multi_select":
			return { multi_select: (value as string[]).map((name) => ({ name })) };
		case "relation":
			return { relation: (value as string[]).map((id) => ({ id })) };
		default:
			throw new Error(`notion.upsert: can't write a "${p.type}" property`);
	}
};

// upsert(model, record, keyProp) — write a record to a data source, idempotently by keyProp:
// the page whose keyProp equals record[keyProp] is updated in place, else a new page is
// created. The inverse of describe; model semantics stay with the caller. Returns the page
// id, its url, and whether it was created.
const pageUrl = (id: string): string => `https://www.notion.so/${id.replace(/-/g, "")}`;

// The shared lookup: resolve the model, load its live property map, and find the one
// page whose keyProp equals value. upsert writes through it; read reads through it.
const locate = async (
	model: string,
	keyProp: string,
	value: unknown
): Promise<{
	dsId: string;
	ds: DataSource;
	page?: { id: string; properties: Record<string, NotionValue> };
}> => {
	const dsId = await resolveDsId(model);
	const ds = await loadDs(dsId);
	const key = ds.properties[keyProp];
	if (!key) throw new Error(`notion: no key property "${keyProp}" on "${model}"`);
	// A relation is keyed by "contains this one id" (Notion has no relation `equals`); every other
	// writable type keys by equality. This lets a row be identified by the ENTITY it points at — a
	// Lead by its Person — rather than a mutable label, so a rename updates the row instead of forking it.
	const clause =
		key.type === "relation"
			? { relation: { contains: Array.isArray(value) ? value[0] : value } }
			: { [key.type]: { equals: value } };
	const { results } = await api<{ results: { id: string; properties: Record<string, NotionValue> }[] }>(
		`/data_sources/${dsId}/query`,
		{ body: { filter: { property: keyProp, ...clause }, page_size: 1 } }
	);
	return { dsId, ds, page: results[0] };
};

export const upsert = async (model: string, record: object, keyProp: string): Promise<Ref> => {
	const fields = record as Record<string, unknown>;
	const { dsId, ds, page } = await locate(model, keyProp, fields[keyProp]);
	const properties: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(fields)) {
		const p = ds.properties[name];
		if (!p) throw new Error(`notion.upsert: no property "${name}" on "${model}"`);
		if (value != null) properties[name] = serialize(value, p);
	}
	let id: string;
	let created: boolean;
	if (page) {
		await api(`/pages/${page.id}`, { method: "PATCH", body: { properties } });
		({ id, created } = { id: page.id, created: false });
	} else {
		const body = { parent: { type: "data_source_id", data_source_id: dsId }, properties };
		({ id } = await api<{ id: string }>("/pages", { body }));
		created = true;
	}
	return { id, url: pageUrl(id), created };
};

// A page → a Row: its id plus every property flattened to a plain scalar (relations and other
// pointerish types drop to null and are skipped). The one page→Row mapping, shared by read,
// query and get so the three return the same shape.
const rowOf = (page: { id: string; properties: Record<string, NotionValue> }): Row => {
	const fields: Record<string, string | number | boolean> = {};
	for (const [name, v] of Object.entries(page.properties)) {
		const s = plain(v);
		if (s !== null && s !== "") fields[name] = s;
	}
	return { id: page.id, fields };
};

// read(model, keyProp, value) — the one page whose keyProp equals value, flattened to
// plain scalars. Loud when absent: in the face of a missing record, refuse to guess.
export const read = async (model: string, keyProp: string, value: unknown): Promise<Row> => {
	const { page } = await locate(model, keyProp, value);
	if (!page) throw new Error(`notion.read: no "${model}" page with ${keyProp} = ${value}`);
	return rowOf(page);
};

// query(model, filter) — every row of a data source matching a Notion filter object (e.g.
// `{ property: "Human verdict", select: { is_empty: true } }`). read is this taking the first
// equals-match; query keeps the whole set — the queue an agent lists.
//
// ONE page, at `page_size` = Notion's documented maximum, and loud when that still isn't the whole
// set. Callers reason on absence — "no lead at this status", "no decision carries feedback" — and
// act on it (advance, reset, re-run), so a silently capped page manufactures false negatives.
// Notion says when it truncated (`has_more`); refuse rather than hand back a partial set
// indistinguishable from a complete one.
const PAGE = 100;

// queryPage(model, filter) — ONE page of matches plus whether more exist: the worklist primitive.
// A drain loop (process a page — which moves rows out of the filter — then re-query) is the one
// legitimate consumer of a partial set; anything reasoning on absence goes through `query`.
export const queryPage = async (model: string, filter: object): Promise<{ rows: Row[]; more: boolean }> => {
	const dsId = await resolveDsId(model);
	const { results, has_more } = await api<{
		results: { id: string; properties: Record<string, NotionValue> }[];
		has_more?: boolean;
	}>(`/data_sources/${dsId}/query`, { body: { filter, page_size: PAGE } });
	return { rows: results.map(rowOf), more: !!has_more };
};

export const query = async (model: string, filter: object): Promise<Row[]> => {
	const { rows, more } = await queryPage(model, filter);
	if (more)
		throw new Error(
			`notion.query: "${model}" matched more rows than one page returns (${rows.length}) — ` +
				`this result is truncated, so absence from it proves nothing. Narrow the filter, or drain via queryPage.`
		);
	return rows;
};

// get(id) — the page with this id, flattened like read. A page id already implies its data
// source, so no model is needed (like title); an id / Notion URL / app URL resolves via idOf.
export const get = async (id: string): Promise<Row> =>
	rowOf(await api<{ id: string; properties: Record<string, NotionValue> }>(`/pages/${idOf(id)}`));

// title(_model, id) — a record's title property as plain text (its "Name"). Lets a caller
// derive one record's identity from another it points at (a Lead's name from its Person).
// A Notion page id already implies its model, so `model` is unused.
export const title = async (_model: string, id: string): Promise<string> => {
	const page = await api<{
		properties: Record<string, { type: string; title?: { plain_text: string }[] }>;
	}>(`/pages/${id}`);
	const t = Object.values(page.properties).find((p) => p.type === "title")?.title ?? [];
	return t.map((x) => x.plain_text).join("");
};

// archive(id) — move a page to Notion's trash (recoverable there; `in_trash` is page state, not a
// property, so upsert can't express it). How eager work that no longer matters is deleted — the
// append-only rule holds for judged decisions, not for drafts a cleanup or a rejecting gate voids.
export const archive = async (id: string): Promise<void> => {
	await api(`/pages/${idOf(id)}`, { method: "PATCH", body: { in_trash: true } });
};

// comment(id, text) — append a top-level comment to a page: the append-only obs trail for why a
// record landed where it did (a deterministic reject reason, a human's overturn). Reuses the same
// rich-text codec as a property write; a page id already implies its parent, so no model is needed.
export const comment = async (id: string, text: string): Promise<void> => {
	await api("/comments", { body: { parent: { page_id: idOf(id) }, rich_text: chunks(text) } });
};

// body(id) — a page's CONTENT as markdown: the read counterpart of `comment` (text in, text out;
// a page id already implies its model). Prose is authored, not compiled, so it lives in the body,
// never a column — a Prompt's instructions are the body of its page (and `chunks`' 100-item cap is
// why a column could never hold them anyway). Paging and rendering are the codec's; this is transport.
export const body = (id: string): Promise<string> =>
	bodyOf(idOf(id), (blockId, cursor) =>
		api<BlockPage>(`/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`)
	);

// describe(model) — a JSON Schema of the model's writable properties. The data source
// id rides in `$id` so a writer can recover it; `title` names the dump file. Properties
// are sorted by name so the file is stable and `git diff` reads as a changelog.
export const describe = async (model: string): Promise<Record<string, unknown>> => {
	const ds = await loadDs(await resolveDsId(model));
	const title = ds.title.map((t) => t.plain_text).join("") || ds.id;
	const properties: Record<string, unknown> = {};
	const required: string[] = [];
	for (const [name, p] of Object.entries(ds.properties).sort((a, b) =>
		a[0].localeCompare(b[0])
	)) {
		const frag = fragment(p);
		if (!frag) continue;
		properties[name] = frag;
		if (p.type === "title") required.push(name); // the one always-present field
	}
	return {
		$schema: "http://json-schema.org/draft-07/schema#",
		$id: ds.id,
		title,
		type: "object",
		additionalProperties: false,
		...(required.length ? { required } : {}),
		properties
	};
};

// The Store this module implements (Notion is the full System of Record).
export const notion: Store = { describe, upsert, read, query, queryPage, get, title, body, comment, archive };
