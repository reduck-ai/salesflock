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

// A block, as the API returns it: `type` names the payload key that carries its rich text
// (block.paragraph.rich_text, block.heading_2.rich_text, …), so the reader is one lookup.
export interface NotionBlock {
	id: string;
	type: string;
	has_children?: boolean;
	[payload: string]: unknown;
}
export interface BlockPage {
	results: NotionBlock[];
	has_more: boolean;
	next_cursor: string | null;
}

// A rich-text run, with the annotations a property read doesn't carry (plain() drops them —
// a property is a scalar; a body is a document).
interface RichText {
	plain_text: string;
	href?: string | null;
	annotations?: { bold?: boolean; italic?: boolean; code?: boolean };
}

// Runs → markdown: the inverse of what a reader's markdown renderer will do to it, so text
// authored in Notion's editor reaches an LLM as the markdown it looks like.
const inline = (runs: RichText[]): string =>
	runs
		.map((r) => {
			const a = r.annotations ?? {};
			let s = r.plain_text;
			if (a.code) s = `\`${s}\``;
			if (a.bold) s = `**${s}**`;
			if (a.italic) s = `_${s}_`;
			return r.href ? `[${s}](${r.href})` : s;
		})
		.join("");

// Block type → its line prefix. A type absent here renders its rich text bare (a paragraph),
// so an unknown block loses its shape but never its text.
const MARKER: Record<string, string> = {
	heading_1: "# ",
	heading_2: "## ",
	heading_3: "### ",
	bulleted_list_item: "- ",
	numbered_list_item: "1. ",
	quote: "> ",
	callout: "> "
};
// The types that read as one list, so consecutive items join by a single newline.
const LIST = new Set(["bulleted_list_item", "numbered_list_item", "to_do"]);

// Containers that carry NO text of their own — a synced block is a transclusion (the one authored
// copy of a generic section, reused by every Prompt that syncs it) and a column is layout. Their
// children belong at the container's own level: indenting them would nest content the author never
// nested, and at four spaces markdown reads their heading as a code block instead.
const TRANSPARENT = new Set(["synced_block", "column_list", "column"]);

const runsOf = (b: NotionBlock): RichText[] =>
	((b[b.type] as { rich_text?: RichText[] } | undefined)?.rich_text ?? []) as RichText[];

const renderBlock = (b: NotionBlock): string => {
	if (b.type === "divider") return "---";
	if (b.type === "code") {
		const { language } = (b.code ?? {}) as { language?: string };
		return `\`\`\`${language && language !== "plain text" ? language : ""}\n${inline(runsOf(b))}\n\`\`\``;
	}
	if (b.type === "to_do") {
		const { checked } = (b.to_do ?? {}) as { checked?: boolean };
		return `- [${checked ? "x" : " "}] ${inline(runsOf(b))}`;
	}
	return `${MARKER[b.type] ?? ""}${inline(runsOf(b))}`;
};

// Nest a rendered subtree one level. Blank lines stay blank — indenting them would only add
// trailing whitespace to the document the judge reads.
const indent = (s: string): string =>
	s
		.split("\n")
		.map((l) => (l ? `  ${l}` : l))
		.join("\n");

// bodyOf(id, page) — a page's CONTENT as one markdown document. The transport is the caller's
// (this file stays import-free, and the two clients authenticate differently), but paging,
// nesting and rendering are decided HERE so a store read and an app read can never differ.
// Pages to exhaustion and recurses into children: a body cut at a page boundary is a silently
// truncated prompt, so "read it all" is not the caller's discretion. A synced block needs no
// resolving — Notion returns the original's blocks from the REFERENCE's own children endpoint — so
// the recursion already reaches transcluded content; it is only spliced rather than nested (above).
// The transport is a parameter, which is also the test seam: feed it fake pages, assert the markdown.
export const bodyOf = async (
	id: string,
	page: (blockId: string, cursor?: string) => Promise<BlockPage>
): Promise<string> => {
	const blocks: NotionBlock[] = [];
	for (let cursor: string | undefined; ; ) {
		const p = await page(id, cursor);
		blocks.push(...p.results);
		if (!p.has_more || !p.next_cursor) break;
		cursor = p.next_cursor;
	}
	const parts: { type: string; text: string }[] = [];
	for (const b of blocks) {
		const kids = b.has_children ? await bodyOf(b.id, page) : "";
		const text = TRANSPARENT.has(b.type)
			? kids
			: [renderBlock(b), kids && indent(kids)].filter((s) => s.trim()).join("\n");
		if (text.trim()) parts.push({ type: b.type, text }); // an empty paragraph IS the blank line below
	}
	return parts.reduce(
		(md, p, i) => (i ? md + (LIST.has(p.type) && LIST.has(parts[i - 1].type) ? "\n" : "\n\n") + p.text : p.text),
		""
	);
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
