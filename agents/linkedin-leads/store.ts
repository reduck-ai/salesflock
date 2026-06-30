// The state seam — where leads land. The interface is yours; the implementation
// is theirs, selected by LEADS_ADAPTER. Ships with a JSONL default so it runs out
// of the box; add Notion/HubSpot/… by implementing Adapter and wiring it below.

import { appendFile } from "node:fs/promises";

// A lead is the assembled output of the base scripts, keyed by publicId. We don't
// type its inner shape — that's each script's documented output, not ours to copy.
export interface Lead {
	publicId: string;
	card: unknown;
	experience: unknown;
	education: unknown;
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
