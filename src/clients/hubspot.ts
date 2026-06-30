// Minimal raw client for the HubSpot CRM v3 API — 1:1 with the REST surface, no
// semantics of our own. The token comes from the `hubspot` CLI's OAuth session:
// the CLI owns login + refresh (`hubspot auth login`), we just read the token it
// caches. HUBSPOT_TOKEN overrides (e.g. a private-app `pat-…`).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://api.hubapi.com";
const AUTH = join(homedir(), "Library", "Application Support", "hubspot", "auth.json");

const token = async (): Promise<string> =>
	process.env.HUBSPOT_TOKEN ?? JSON.parse(await readFile(AUTH, "utf8")).access_token;

// The 1:1 seam: one authenticated GET against api.hubapi.com.
export const api = async (path: string): Promise<unknown> => {
	const res = await fetch(API + path, {
		headers: { Authorization: `Bearer ${await token()}` }
	});
	if (!res.ok) throw new Error(`HubSpot ${res.status} ${path}: ${await res.text()}`);
	return res.json();
};

// A property as the API returns it — only the fields we read. readOnlyValue is the
// authoritative "can't write this"; options carries enum values the CLI dropped.
export interface Property {
	name: string;
	label: string;
	type: string;
	fieldType: string;
	options: { value: string }[];
	modificationMetadata?: { readOnlyValue?: boolean };
}

// GET /crm/v3/properties/{type} — every property of an object, options included.
export const properties = async (type: string): Promise<Property[]> =>
	((await api(`/crm/v3/properties/${type}`)) as { results: Property[] }).results;

// Project a property to what a writer needs, dropping the unwritable. What lands is
// exactly what the destination takes on write — enum values included (the bit the CLI
// couldn't give).
const project = (p: Property) => ({
	name: p.name,
	label: p.label,
	type: p.type,
	fieldType: p.fieldType,
	...(p.options.length ? { options: p.options.map((o) => o.value) } : {})
});

// describe(type) — the model's writable properties. readOnlyValue is the destination's
// own authoritative "can't write this". Sorted by name so the file is stable and
// `git diff` reads as a changelog. (Not yet a JSON Schema like notion.describe — the
// flat shape is what this client emits today; align to JSON Schema later.)
export const describe = async (type: string) =>
	(await properties(type))
		.filter((p) => !p.modificationMetadata?.readOnlyValue)
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(project);
