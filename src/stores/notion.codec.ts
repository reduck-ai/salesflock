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

// blocksOf(markdown) — the INVERSE of bodyOf: markdown a person authored → the blocks that render it.
// It reads the same vocabulary bodyOf writes (MARKER's prefixes, the fence, the divider, the to_do,
// and `inline`'s four annotations), which is the whole point of it living here: read a page, edit the
// markdown, write it back, and the shapes are the ones it started with. Without it an authored
// "## Heading" lands as a paragraph whose literal text begins with "##".
//
// Deliberately NOT a markdown parser: it recognizes exactly what bodyOf can emit and treats anything
// else as prose. Notion's own errors are the backstop for a shape it would refuse (children on a
// divider, say) — errors never pass silently, so nothing here guesses.

type Block = { object: "block"; type: string; [payload: string]: unknown };
interface Ann {
	bold?: boolean;
	italic?: boolean;
	code?: boolean;
}
type Run = { type: "text"; text: { content: string; link?: { url: string } }; annotations?: Ann };

// One rich-text item, split like `chunks` (2000 chars, never through a surrogate pair). Annotations
// and the link ride along only when set, so a plain run stays the minimal shape chunks writes.
const pushRuns = (out: Run[], s: string, ann: Ann, href?: string): void => {
	for (let i = 0; i < s.length; ) {
		let end = Math.min(i + 2000, s.length);
		if (end < s.length && /[\uD800-\uDBFF]/.test(s[end - 1])) end--;
		out.push({
			type: "text",
			text: { content: s.slice(i, end), ...(href ? { link: { url: href } } : {}) },
			...(Object.keys(ann).length ? { annotations: { ...ann } } : {})
		});
		i = end;
	}
};

// The four forms `inline` emits. Each match recurses into its OWN text carrying the annotation down,
// so `[**bold**](url)` nests correctly; code is the exception — its content is literal by definition,
// so it is never re-parsed.
const INLINE = /\[([^\]\n]*)\]\(([^)\s]*)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|_([^_\n]+)_/;
const richText = (text: string, ann: Ann = {}, href?: string): Run[] => {
	const out: Run[] = [];
	for (let rest = text; ; ) {
		const m = INLINE.exec(rest);
		if (!m) return pushRuns(out, rest, ann, href), out;
		pushRuns(out, rest.slice(0, m.index), ann, href);
		if (m[1] !== undefined) out.push(...richText(m[1], ann, m[2]));
		else if (m[3] !== undefined) pushRuns(out, m[3], { ...ann, code: true }, href);
		else if (m[4] !== undefined) out.push(...richText(m[4], { ...ann, bold: true }, href));
		else out.push(...richText(m[5], { ...ann, italic: true }, href));
		rest = rest.slice(m.index + m[0].length);
	}
};

const block = (type: string, text: string, extra: object = {}): Block => ({
	object: "block",
	type,
	[type]: { rich_text: richText(text), ...extra }
});

// A code block's `language` is a CLOSED enum on Notion's side — an unlisted value fails the whole
// write, so it is resolved here rather than passed through hopefully. The list is Notion's own (it
// names every accepted value in its 400); the aliases are what people actually type in a fence, and
// anything still unrecognized degrades to plain text, because a language label is never worth losing
// a document over.
const CODE_LANGUAGES = new Set(
	("abap abc agda arduino assembly bash basic bnf c c# c++ clojure coffeescript coq css dart dhall diff " +
		"docker ebnf elixir elm erlang f# flow fortran gherkin glsl go graphql groovy haskell hcl html idris " +
		"java javascript json julia kotlin latex less lisp livescript lua makefile markdown markup matlab " +
		"mathematica mermaid nix objective-c ocaml pascal perl php powershell prolog protobuf purescript " +
		"python r racket reason ruby rust sass scala scheme scss shell smalltalk solidity sql swift toml " +
		"typescript verilog vhdl webassembly xml yaml").split(" ")
);
const CODE_ALIAS: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	py: "python",
	rb: "ruby",
	rs: "rust",
	sh: "shell",
	zsh: "shell",
	yml: "yaml",
	md: "markdown",
	dockerfile: "docker",
	"c++": "c++",
	golang: "go",
	kt: "kotlin"
};
const codeLanguage = (fence: string): string => {
	const key = fence.trim().toLowerCase();
	if (!key) return "plain text";
	const named = CODE_ALIAS[key] ?? key;
	return CODE_LANGUAGES.has(named) ? named : "plain text";
};

const FENCE = /^```([\w#+.-]*)\s*$/;
const HEADING = /^(#{1,6}) (.*)$/;
const TODO = /^- \[([ xX])\] (.*)$/;
const BULLET = /^[-*+] (.*)$/;
const NUMBERED = /^\d+\. (.*)$/;
const QUOTE = /^> (.*)$/;

export const blocksOf = (markdown: string): Block[] => {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const out: Block[] = [];
	// Consecutive prose lines are ONE paragraph (a blank line ends it), mirroring bodyOf's join: a
	// soft line break inside a block survives the trip instead of splitting into two blocks.
	let para: string[] = [];
	const flush = () => {
		if (para.length) out.push(block("paragraph", para.join("\n")));
		para = [];
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) {
			flush();
			continue;
		}

		// A two-space indent is how bodyOf nests a subtree, so an indented run belongs to the block
		// above — dedent it and recurse, rather than leaving the spaces in the text.
		if (/^ {2}\S/.test(line)) {
			const kid: string[] = [];
			while (i < lines.length && /^ {2}\S/.test(lines[i])) kid.push(lines[i].slice(2)), i++;
			i--;
			flush();
			const parent = out[out.length - 1];
			if (parent) {
				(parent[parent.type] as { children?: Block[] }).children = blocksOf(kid.join("\n"));
				continue;
			}
			para.push(kid.join("\n")); // nothing to hang it on — keep the text, drop the indent
			continue;
		}

		const fence = FENCE.exec(line);
		if (fence) {
			flush();
			const body: string[] = [];
			for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
			const rich: Run[] = [];
			pushRuns(rich, body.join("\n"), {}); // code content is literal — no inline parsing
			out.push({
				object: "block",
				type: "code",
				code: { rich_text: rich, language: codeLanguage(fence[1]) }
			});
			continue;
		}

		if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
			flush();
			out.push({ object: "block", type: "divider", divider: {} });
			continue;
		}

		const todo = TODO.exec(line);
		const heading = HEADING.exec(line);
		const bullet = BULLET.exec(line);
		const numbered = NUMBERED.exec(line);
		const quote = QUOTE.exec(line);
		if (todo) (flush(), out.push(block("to_do", todo[2], { checked: todo[1].toLowerCase() === "x" })));
		// Notion has only three heading levels; deeper markdown collapses onto the last one.
		else if (heading) (flush(), out.push(block(`heading_${Math.min(heading[1].length, 3)}`, heading[2])));
		else if (bullet) (flush(), out.push(block("bulleted_list_item", bullet[1])));
		else if (numbered) (flush(), out.push(block("numbered_list_item", numbered[1])));
		else if (quote) (flush(), out.push(block("quote", quote[1])));
		else para.push(line);
	}
	flush();
	return out;
};
