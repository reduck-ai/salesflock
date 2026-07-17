// The Notion codec — the wire physics every Notion client here obeys, in one place.
// Pure functions, zero imports: shared by the store (src/stores/notion.ts, ntn CLI auth)
// and the review app (app/src/lib/server/notion.ts, token auth, via its `$core` alias).

// A page property value, as the API returns it — only the shapes plain() flattens.
export interface NotionValue {
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
	relation?: { id: string }[]; // a pointer, not content — plain() reads it as null
}

// A relation property's target page ids ([] when absent) — the one non-scalar a
// reader needs: relations are how Decisions point at their Lead, Prompt and upstreams.
export const relation = (v?: NotionValue): string[] => v?.relation?.map((r) => r.id) ?? [];

// A property value → a plain scalar. null for types with no scalar reading (relations,
// files, …) — they are pointers, not content. Reads need nothing more: current API
// versions return a property's rich text WHOLE on page reads and queries (the historical
// 25-item read cap is gone; its old workaround, the property-items endpoint, now returns
// a single item claiming has_more:false — never use it).
export const plain = (v: NotionValue): string | number | boolean | null => {
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

// Notion caps one rich text item at 2000 chars and a property write at 100 items, so a
// string writes as a run of items up to ~200k chars — fail loud past that rather than
// truncate. Slices never split a surrogate pair: a lone half is invalid JSON on write.
const WRITE_CAP = 100;
export const chunks = (s: string): { text: { content: string } }[] => {
	if (!s) return [{ text: { content: "" } }];
	const out: { text: { content: string } }[] = [];
	for (let i = 0; i < s.length;) {
		let end = Math.min(i + 2000, s.length);
		if (end < s.length && /[\uD800-\uDBFF]/.test(s[end - 1])) end--;
		out.push({ text: { content: s.slice(i, end) } });
		i = end;
	}
	if (out.length > WRITE_CAP)
		throw new Error(
			`notion: ${s.length} chars is ${out.length} rich-text items, over Notion's ${WRITE_CAP}-item ` +
				`write cap (~${WRITE_CAP * 2000} chars). Put this field in the page body instead.`
		);
	return out;
};
