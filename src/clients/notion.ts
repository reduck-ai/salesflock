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
