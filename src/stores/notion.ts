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
import { pace, NOTION_RPS } from "../concurrency.js";
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

// One clock for the whole Notion backend. Notion limits a RATE (~3 rps per connection, plus a
// workspace-wide limit shared with every other connection), so every request starts through the
// pacer — and when Notion says stop, `hold` parks EVERY caller for exactly as long as its
// Retry-After says, instead of each one discovering the same ban privately and failing alone.
// 429 (rate_limited) and 529 (service_overload) are the same event and handled identically, per
// Notion's docs. Nothing is capped at "a ban too long to wait for": parking costs nothing now that
// callers park together, so the run waits it out and keeps its work — bounded only by MAX_WAIT so
// it can never hang forever. The park is one of this backend's two diagnostics (an exceptional, slow
// event); the other is `traced` below, on the writes. READS stay quiet — a read answers in one
// round-trip and its caller is blocked on it, so a line per read would be noise, not a trace.
const API = "https://api.notion.com/v1";
const slot = pace(NOTION_RPS);
const MAX_WAIT = Number(process.env.NOTION_MAX_WAIT) || 900_000; // total parked time one call accepts
// Notion names which limit was hit (`public_api_request_rate_limit` — this connection — vs
// `public_api_space_request_rate_limit` — the whole workspace, i.e. someone else's traffic too).
// Worth saying out loud: it is the difference between "slow down" and "you are not alone in here".
const reasonOf = (text: string): string => {
	try {
		return (JSON.parse(text) as { additional_data?: { rate_limit_reason?: string } })?.additional_data
			?.rate_limit_reason ?? "rate_limited";
	} catch {
		return "rate_limited";
	}
};
// What one logical operation actually cost, kept apart because the two halves mean opposite things.
// A `write` figure says how heavy this row was; a `queued` figure says how busy the pacer was, which
// is a fact about the RUN and not about the row — one call's queue time is every other caller's work.
// Fusing them (the elapsed a stopwatch around the whole call gives) reads as "this record took 8
// seconds", which would be wrong in the way that matters: it invites shrinking the record when the
// only thing that would help is making fewer requests or letting fewer of them race.
export interface Meter {
	calls: number; // paced requests spent, retries included
	work: number; // ms actually spent in flight to Notion
	queued: number; // ms parked waiting for the pacer's clock (and for any 429 hold)
}
const api = async <T>(
	path: string,
	init?: { method?: string; body?: object },
	meter?: Meter
): Promise<T> => {
	for (let attempt = 0, waited = 0; ; attempt++) {
		// Both instants come from HERE, not from inside `pace`: the pacer's job is to decide when a
		// request may start, and the gap between "we asked" and "it started" IS the wait — so measuring
		// it at the seam that spans both needs no extra bookkeeping in the clock itself.
		const asked = Date.now();
		let started = 0;
		const res = await slot(async () => {
			started = Date.now();
			return fetch(API + path, {
				method: init?.method ?? (init?.body ? "POST" : "GET"),
				headers: {
					Authorization: `Bearer ${await token()}`,
					"Notion-Version": "2025-09-03",
					"Content-Type": "application/json"
				},
				body: init?.body ? JSON.stringify(init.body) : undefined
			});
		});
		if (meter) {
			meter.calls++;
			meter.queued += started - asked;
			meter.work += Date.now() - started;
		}
		if (res.ok) return (await res.json()) as T;
		const text = await res.text();
		if (res.status !== 429 && res.status !== 529)
			throw new Error(`notion ${res.status} ${init?.method ?? "GET"} ${path}: ${text}`);
		// Retry-After is authoritative when present (integer seconds); exponential backoff otherwise.
		const wait = Number(res.headers.get("retry-after")) * 1000 || 500 * 2 ** attempt;
		if (waited + wait > MAX_WAIT)
			throw new Error(
				`notion ${res.status} ${path}: rate-limited for ${Math.round(wait / 1000)}s, past the ` +
					`${Math.round(MAX_WAIT / 1000)}s wait budget (NOTION_MAX_WAIT) — try again later`
			);
		slot.hold(wait); // every caller, in flight and future, now waits behind this
		waited += wait;
		log(
			"notion",
			`${res.status} ${reasonOf(text)} — all calls parked ${Math.round(wait / 1000)}s, ` +
				`then ${slot.rps().toFixed(1)} rps …`
		);
	}
};

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

// memo(cache, key, load) — one FLIGHT per key, not one value per key, and that difference is the
// whole point: these caches serve a fan-out, so what has to be deduped is the request in the air,
// not the answer once it lands. Caching the value means every caller that starts before the first
// one returns misses, and they all fetch — a stampede exactly as wide as TASK_CONCURRENCY, paid on
// every process against a rate-limited backend. (Measured, once the write trace made it visible: a
// scan's first rows each spent 3–4 paced requests where the steady state is 2.) Storing the promise
// makes the second caller wait on the first's request instead of issuing its own.
//
// A rejection is never cached — it would poison the process — so the entry is dropped and a retry
// re-reads. The same idiom, for the same reason, as `loadPrompt`'s contract cache in src/prompts.ts.
//
// One honest consequence for the trace: only the caller that opens the flight is charged for it,
// since the others spend no request. `calls` is what I asked Notion for, not what I waited on.
const memo = <K, V>(cache: Map<K, Promise<V>>, key: K, load: () => Promise<V>): Promise<V> => {
	const hit = cache.get(key);
	if (hit) return hit;
	const flight = load().catch((e: unknown) => {
		cache.delete(key);
		throw e;
	});
	cache.set(key, flight);
	return flight;
};

// Resolve a model handle (database id / data-source id / URL) to a data source id.
// `GET /databases/{id}` lists a DATABASE's data source(s); given a value that is already
// a data source id it 404s, so a failed lookup means "use it directly".
// Memoized: a model→dsId mapping is stable for the life of a (short-lived) CLI process.
const dsIdCache = new Map<string, Promise<string>>();
const resolveDsId = (model: string, meter?: Meter): Promise<string> =>
	memo(dsIdCache, model, async () => {
		const id = idOf(model);
		const db = await api<{ data_sources?: { id: string }[] }>(`/databases/${id}`, undefined, meter).catch(
			() => null
		);
		const ids = db?.data_sources?.map((d) => d.id) ?? [];
		if (ids.length > 1)
			throw new Error(
				`"${model}" is a database with ${ids.length} data sources — pass one of: ${ids.join(", ")}`
			);
		return ids[0] ?? id;
	});

// A data source's schema (its property map) — also stable per process, so fetch it once per id;
// the cache removes the repeated schema fetch every locate/describe made.
const dsCache = new Map<string, Promise<DataSource>>();
const loadDs = (dsId: string, meter?: Meter): Promise<DataSource> =>
	memo(dsCache, dsId, () => api<DataSource>(`/data_sources/${dsId}`, undefined, meter));

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
export const pageUrl = (id: string): string => `https://www.notion.so/${id.replace(/-/g, "")}`;

// The shared lookup: resolve the model, load its live property map, and find the one
// page whose keyProp equals value. upsert writes through it; read reads through it.
const locate = async (
	model: string,
	keyProp: string,
	value: unknown,
	meter?: Meter
): Promise<{
	dsId: string;
	ds: DataSource;
	page?: { id: string; properties: Record<string, NotionValue> };
}> => {
	// Metered too, though both are memoized: the first write of a run genuinely pays for them, and a
	// count that quietly excluded the schema fetches would be the same half-truth the elapsed was.
	const dsId = await resolveDsId(model, meter);
	const ds = await loadDs(dsId, meter);
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
		{ body: { filter: { property: keyProp, ...clause }, page_size: 1 } },
		meter
	);
	return { dsId, ds, page: results[0] };
};

// A record → the API's `properties` payload, against the model's live schema. Shared by upsert and
// create, so the two can't serialize a field differently.
const propertiesOf = (
	ds: DataSource,
	model: string,
	fields: Record<string, unknown>
): Record<string, unknown> => {
	const properties: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(fields)) {
		const p = ds.properties[name];
		if (!p) throw new Error(`notion: no property "${name}" on "${model}"`);
		if (value != null) properties[name] = serialize(value, p);
	}
	return properties;
};

// traced(op, label, write) — the WRITE seam's emission, and the same convention the reduck runner
// already obeys (src/clients/reduck.ts): a start line BEFORE the work, a done line with the elapsed
// after. So a stalled write is a dangling start with no done, and the phase reports itself as it
// happens rather than at the end — which is the whole point, because the answer only reaches stdout
// when the process exits, and a backgrounded run is read through this line or not at all.
//
// It lives HERE, in the backend, and not in the caller that happened to need it: the reduck client
// logs its own I/O, so a store that stayed silent was the one gap in an otherwise complete trace —
// for every agent and every stage at once, not just the one being debugged. (Measured, and this is
// what it costs: a 413-thread scan spent 16s in the browser, all of it logged, and ~7 minutes in
// these upserts, none of it — a run indistinguishable from a hung one for its whole duration.)
//
// The label self-tags each pair (model + the row's key), so concurrent writes stay attributable
// across interleaved output; the outcome says which of the two things an upsert did.
//
// The done line reports the cost SPLIT (see `Meter`), because the single elapsed it used to print
// was true and misleading at once: it read 8s per row, of which ~800ms was Notion and the rest was
// this call waiting its turn on a 2.5 rps clock shared with 8 concurrent siblings. Read as a per-row
// cost it points at the row; read as `2 calls, 786ms, queued 6.4s` it points where the time really
// is — at the request COUNT and the fan-out width, which are the only two things that would change it.
const ms = (n: number): string => (n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);
const traced = async (op: string, label: string, write: (meter: Meter) => Promise<Ref>): Promise<Ref> => {
	log("notion", `${op} ${label} …`);
	const meter: Meter = { calls: 0, work: 0, queued: 0 };
	const ref = await write(meter);
	log(
		"notion",
		`${op} ${label} → ${ref.created ? "created" : "updated"} ` +
			`(${meter.calls} calls, ${ms(meter.work)}, queued ${ms(meter.queued)})`
	);
	return ref;
};

// The model is a bare uuid, which says nothing at a glance and is 36 characters of it; its first
// segment is enough to tell one table's writes from another's in a mixed trace, and the key is what
// actually identifies the row.
const labelOf = (model: string, key: unknown): string =>
	`${idOf(model).slice(0, 8)} ${key == null || key === "" ? "(no key)" : String(key)}`;

// create(model, record) — one POST, no lookup: the write for a row whose identity is unique by
// construction (an append-only Decision). Two calls where upsert costs three, and the intent is in
// the name rather than in a key that can never match.
// A created row has no key to name it by — its identity is the page that is about to exist — so the
// trace uses the Name it is being born with, which is what a reader would recognize anyway.
export const create = (model: string, record: object): Promise<Ref> =>
	traced("create", labelOf(model, (record as Record<string, unknown>).Name), async (meter) => {
		const dsId = await resolveDsId(model, meter);
		const ds = await loadDs(dsId, meter);
		const { id } = await api<{ id: string }>(
			"/pages",
			{
				body: {
					parent: { type: "data_source_id", data_source_id: dsId },
					properties: propertiesOf(ds, model, record as Record<string, unknown>)
				}
			},
			meter
		);
		return { id, url: pageUrl(id), created: true };
	});

export const upsert = (model: string, record: object, keyProp: string): Promise<Ref> => {
	const fields = record as Record<string, unknown>;
	return traced("upsert", labelOf(model, fields[keyProp]), async (meter) => {
		const { dsId, ds, page } = await locate(model, keyProp, fields[keyProp], meter);
		const properties = propertiesOf(ds, model, fields);
		let id: string;
		let created: boolean;
		if (page) {
			await api(`/pages/${page.id}`, { method: "PATCH", body: { properties } }, meter);
			({ id, created } = { id: page.id, created: false });
		} else {
			const body = { parent: { type: "data_source_id", data_source_id: dsId }, properties };
			({ id } = await api<{ id: string }>("/pages", { body }, meter));
			created = true;
		}
		return { id, url: pageUrl(id), created };
	});
};

// patch(model, id, record) — write columns on the page you name. `upsert` locates a row by key then
// PATCHes it; this is that PATCH with the lookup removed, for a row whose identity is not a column
// (a Decision is created, never keyed, so no `upsert` can ever reach it). The model is still needed
// — Notion resolves the page by id, but serializing a value needs the data source's property types.
// An empty string clears a text property, which is how a note is moved out rather than duplicated.
export const patch = (model: string, id: string, record: object): Promise<Ref> =>
	traced("patch", labelOf(model, idOf(id)), async (meter) => {
		const dsId = await resolveDsId(model, meter);
		const ds = await loadDs(dsId, meter);
		const properties = propertiesOf(ds, model, record as Record<string, unknown>);
		await api(`/pages/${idOf(id)}`, { method: "PATCH", body: { properties } }, meter);
		return { id: idOf(id), url: pageUrl(idOf(id)), created: false };
	});

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

// queryPage(model, filter, cursor?) — ONE page of matches, whether more exist, and the cursor to
// the next page: the worklist primitive (a drain re-queries with no cursor — processing moved the
// rows out) and, via the cursor, `queryAll`'s full read. Anything reasoning on absence goes
// through `query`.
export const queryPage = async (
	model: string,
	filter: object,
	cursor?: string
): Promise<{ rows: Row[]; more: boolean; cursor?: string }> => {
	const dsId = await resolveDsId(model);
	const { results, has_more, next_cursor } = await api<{
		results: { id: string; properties: Record<string, NotionValue> }[];
		has_more?: boolean;
		next_cursor?: string | null;
	}>(`/data_sources/${dsId}/query`, {
		body: { filter, page_size: PAGE, ...(cursor ? { start_cursor: cursor } : {}) }
	});
	return { rows: results.map(rowOf), more: !!has_more, ...(next_cursor ? { cursor: next_cursor } : {}) };
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
const blockPage = (blockId: string, cursor?: string): Promise<BlockPage> =>
	api<BlockPage>(`/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);

export const body = (id: string): Promise<string> => bodyOf(idOf(id), blockPage);

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
export const notion: Store = {
	describe,
	upsert,
	create,
	patch,
	read,
	query,
	queryPage,
	get,
	title,
	body,
	comment,
	archive
};
