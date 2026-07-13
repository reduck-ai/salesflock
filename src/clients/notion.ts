// Minimal Notion client — describes a Notion model (a database / data source) as a
// JSON Schema of its WRITABLE properties: exactly what a writer can set, enums and
// relation targets included. The semantic mapping (Notion property type → JSON Schema
// fragment) is the one Notion-specific thing here; the schema it emits is the uniform
// contract the generic layer compiles to TS.
//
// Auth is the `ntn` CLI's own (keychain) session: we shell `ntn`, so login/refresh
// stays the CLI's job and we never hold a token. A profile NOTION_API_TOKEN is an
// *integration* identity that can't see a personal CRM (404), so we drop it and let
// `ntn` use the logged-in person.

import { spawn } from "node:child_process";

// Strip the integration token so `ntn` falls back to the personal keychain login.
const ntnEnv = (() => {
	const { NOTION_API_TOKEN, ...env } = process.env;
	return env;
})();

// Run `ntn` and capture stdout. stdin is closed ("ignore"): `ntn api` reads a request
// body from stdin, so an open empty pipe would hang it forever.
const ntn = (args: string[]): Promise<string> =>
	new Promise((resolve, reject) => {
		const child = spawn("ntn", args, { env: ntnEnv, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0 ? resolve(out) : reject(new Error(`ntn ${args.join(" ")} → exit ${code}: ${err.trim()}`))
		);
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

// A bare 32-hex id out of a raw id or a Notion URL.
const idOf = (s: string): string => s.match(/[0-9a-f]{32}/i)?.[0] ?? s;

// Resolve a model handle (database id / data-source id / URL) to a data source id.
// `datasources resolve` maps a DATABASE id → its data source(s); given a value that is
// already a data source id it errors, so a failed resolve means "use it directly".
const resolveDsId = async (model: string): Promise<string> => {
	const id = idOf(model);
	const out = await ntn(["datasources", "resolve", id]).catch(() => "");
	const ids = out
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t")[0]);
	if (ids.length > 1)
		throw new Error(
			`"${model}" is a database with ${ids.length} data sources — pass one of: ${ids.join(", ")}`
		);
	return ids[0] ?? id;
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

// Notion caps one rich text item at 2000 chars; longer strings are written as a run of
// items, so callers never truncate.
const chunks = (s: string): { text: { content: string } }[] => {
	const out: { text: { content: string } }[] = [];
	for (let i = 0; i < Math.max(s.length, 1); i += 2000) out.push({ text: { content: s.slice(i, i + 2000) } });
	return out;
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

// A page property value, as the API returns it — only the shapes plain() flattens.
interface NotionValue {
	type: string;
	title?: { plain_text: string }[];
	rich_text?: { plain_text: string }[];
	url?: string | null;
	email?: string | null;
	phone_number?: string | null;
	number?: number | null;
	checkbox?: boolean;
	date?: { start: string } | null;
	select?: { name: string } | null;
	status?: { name: string } | null;
	multi_select?: { name: string }[];
}

// The inverse of serialize: a property value → a plain scalar. null for types with no
// scalar reading (relations, files, …) — they are pointers, not content.
const plain = (v: NotionValue): string | number | boolean | null => {
	switch (v.type) {
		case "title":
		case "rich_text":
			return (v[v.type] ?? []).map((t) => t.plain_text).join("");
		case "url":
			return v.url ?? null;
		case "email":
			return v.email ?? null;
		case "phone_number":
			return v.phone_number ?? null;
		case "number":
			return v.number ?? null;
		case "checkbox":
			return v.checkbox ?? null;
		case "date":
			return v.date?.start ?? null;
		case "select":
		case "status":
			return (v.type === "select" ? v.select : v.status)?.name ?? null;
		case "multi_select":
			return (v.multi_select ?? []).map((o) => o.name).join(", ") || null;
		default:
			return null;
	}
};

// The shared lookup: resolve the model, load its live property map, and find the one
// page whose keyProp equals value. upsert writes through it; read reads through it.
const locate = async (
	model: string,
	keyProp: string,
	value: unknown
): Promise<{ dsId: string; ds: DataSource; page?: { id: string; properties: Record<string, NotionValue> } }> => {
	const dsId = await resolveDsId(model);
	const ds: DataSource = JSON.parse(await ntn(["api", `/v1/data_sources/${dsId}`]));
	const key = ds.properties[keyProp];
	if (!key) throw new Error(`notion: no key property "${keyProp}" on "${model}"`);
	const filter = JSON.stringify({ property: keyProp, [key.type]: { equals: value } });
	const { results } = JSON.parse(await ntn(["datasources", "query", dsId, "--filter", filter, "--json"]));
	return { dsId, ds, page: results[0] };
};

// content, when given, is the page's body as Markdown — replaced wholesale on every
// upsert, so the body converges exactly like the properties do.
export const upsert = async (
	model: string,
	record: object,
	keyProp: string,
	content?: string
): Promise<{ id: string; url: string; created: boolean }> => {
	const fields = record as Record<string, unknown>;
	const { dsId, ds, page } = await locate(model, keyProp, fields[keyProp]);
	const properties: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(fields)) {
		const p = ds.properties[name];
		if (!p) throw new Error(`notion.upsert: no property "${name}" on "${model}"`);
		if (value != null) properties[name] = serialize(value, p);
	}
	const write = (args: string[]) => ntn(["api", ...args, "-d", JSON.stringify({ properties })]);
	let id: string;
	let created: boolean;
	if (page) {
		await write(["-X", "PATCH", `/v1/pages/${page.id}`]);
		({ id, created } = { id: page.id, created: false });
	} else {
		const body = { parent: { type: "data_source_id", data_source_id: dsId }, properties };
		({ id } = JSON.parse(await ntn(["api", "-X", "POST", "/v1/pages", "-d", JSON.stringify(body)])));
		created = true;
	}
	if (content) await ntn(["pages", "edit", id, "--content", content]);
	return { id, url: pageUrl(id), created };
};

// read(model, keyProp, value) — the one page whose keyProp equals value, flattened to
// plain scalars. Loud when absent: in the face of a missing record, refuse to guess.
export const read = async (
	model: string,
	keyProp: string,
	value: unknown
): Promise<{ id: string; fields: Record<string, string | number | boolean> }> => {
	const { page } = await locate(model, keyProp, value);
	if (!page) throw new Error(`notion.read: no "${model}" page with ${keyProp} = ${value}`);
	const fields: Record<string, string | number | boolean> = {};
	for (const [name, v] of Object.entries(page.properties)) {
		const s = plain(v);
		if (s !== null && s !== "") fields[name] = s;
	}
	return { id: page.id, fields };
};

// pageTitle(pageId) — a page's title property as plain text (its "Name"). Lets a caller
// derive one record's identity from another it points at (a Lead's name from its Person).
export const pageTitle = async (pageId: string): Promise<string> => {
	const page = JSON.parse(await ntn(["api", `/v1/pages/${pageId}`])) as {
		properties: Record<string, { type: string; title?: { plain_text: string }[] }>;
	};
	const title = Object.values(page.properties).find((p) => p.type === "title")?.title ?? [];
	return title.map((t) => t.plain_text).join("");
};

// describe(model) — a JSON Schema of the model's writable properties. The data source
// id rides in `$id` so a writer can recover it; `title` names the dump file. Properties
// are sorted by name so the file is stable and `git diff` reads as a changelog.
export const describe = async (model: string): Promise<Record<string, unknown>> => {
	const ds: DataSource = JSON.parse(await ntn(["api", `/v1/data_sources/${await resolveDsId(model)}`]));
	const title = ds.title.map((t) => t.plain_text).join("") || ds.id;
	const properties: Record<string, unknown> = {};
	const required: string[] = [];
	for (const [name, p] of Object.entries(ds.properties).sort((a, b) => a[0].localeCompare(b[0]))) {
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
