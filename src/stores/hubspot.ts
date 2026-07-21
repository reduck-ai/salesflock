// Minimal raw client for the HubSpot CRM v3 API — 1:1 with the REST surface, no
// semantics of our own. The token comes from the `hubspot` CLI's OAuth session:
// the CLI owns login + refresh (`hubspot auth login`), we just read the token it
// caches. HUBSPOT_TOKEN overrides (e.g. a private-app `pat-…`).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Store } from "./index.js";

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

// HubSpot property `type` → JSON Schema fragment, mirroring notion's `fragment` so both
// stores emit the same shape and `sflock` compiles them identically. enum values ride in
// (the bit the CLI couldn't give); every other writable scalar is a string.
const fragment = (p: Property): Record<string, unknown> => {
	switch (p.type) {
		case "number":
			return { type: "number" };
		case "bool":
			return { type: "boolean" };
		case "date":
		case "datetime":
			return { type: "string", description: "ISO 8601 date or date-time" };
		case "enumeration":
			return { type: "string", enum: p.options.map((o) => o.value) };
		default:
			return { type: "string" }; // string, phone_number, and any other writable scalar
	}
};

// describe(type) — the object's writable properties as a JSON Schema, identical in shape to
// notion.describe: readOnlyValue props dropped, sorted by name so `git diff` reads as a
// changelog. This is the setup half of the Store contract HubSpot fully implements today.
export const describe = async (type: string): Promise<Record<string, unknown>> => {
	const writable = (await properties(type))
		.filter((p) => !p.modificationMetadata?.readOnlyValue)
		.sort((a, b) => a.name.localeCompare(b.name));
	const props: Record<string, unknown> = {};
	for (const p of writable) props[p.name] = fragment(p);
	return {
		$schema: "http://json-schema.org/draft-07/schema#",
		$id: type,
		title: type,
		type: "object",
		additionalProperties: false,
		properties: props
	};
};

// The runtime write path is not built yet — DESTINATION=hubspot is describe-only. Fail
// loud rather than write a wrong shape silently (errors should never pass silently).
const notImplemented = (): never => {
	throw new Error(
		"hubspot: write path not implemented — DESTINATION=hubspot is describe-only today"
	);
};

// The Store this module implements: the setup half (describe) is real; the write half and the
// runtime reads throw (describe-only today).
export const hubspot: Store = {
	describe,
	upsert: notImplemented,
	read: notImplemented,
	query: notImplemented,
	get: notImplemented,
	title: notImplemented,
	comment: notImplemented
};
