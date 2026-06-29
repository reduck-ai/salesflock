// The state seam — where leads land. The interface is yours; the implementation
// is theirs, selected by LEADS_ADAPTER. Ships with a JSONL default so it runs out
// of the box; add Notion/HubSpot/… by implementing Adapter and wiring it below.

import { appendFile } from "node:fs/promises";

export interface Lead {
	profile: Record<string, unknown>;
	experience: unknown;
	education: unknown;
	company: unknown;
}

export interface Adapter {
	upsert(lead: Lead): Promise<void>;
}

const jsonl = (path: string): Adapter => ({
	upsert: (lead) => appendFile(path, JSON.stringify(lead) + "\n")
});

export const makeAdapter = (kind = process.env.LEADS_ADAPTER ?? "jsonl"): Adapter => {
	switch (kind) {
		case "jsonl":
			return jsonl(process.env.LEADS_FILE ?? "leads.jsonl");
		// Bring your own — implement Adapter and add a case:
		// case "notion": return notion(process.env.NOTION_TOKEN!, process.env.NOTION_DB!);
		// case "hubspot": return hubspot(process.env.HUBSPOT_TOKEN!);
		default:
			throw new Error(`unknown LEADS_ADAPTER "${kind}" — add it in adapter.ts`);
	}
};
