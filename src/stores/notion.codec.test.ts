// bodyOf's tests — the reader that turns a Notion page's blocks into the one markdown document a
// judge reads. Testable with no network because the transport is a PARAMETER: each case builds a
// fake `page(blockId, cursor)` over a plain map of block ids → pages.
//
// The fake is not fiction: every shape below was captured from the live API first — in particular a
// synced REFERENCE carries no rich_text at all, only `synced_from.block_id`, yet reports
// has_children: true and serves the ORIGINAL's blocks from its own children endpoint (each child
// reporting parent.block_id = the original). That is why bodyOf needs no resolve step.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	bodyOf,
	compileAuthoring,
	segmentsOf,
	type BlockPage,
	type NotionBlock
} from "./notion.codec.js";

const rt = (s: string, annotations = {}, href: string | null = null) => ({ plain_text: s, annotations, href });

// A block, in the shape the API returns. `kids` marks has_children; the children live in the tree
// under the block's own id, exactly as the API serves them.
const b = (id: string, type: string, payload: object, kids = false): NotionBlock =>
	({ id, type, has_children: kids, [type]: payload }) as NotionBlock;

const para = (id: string, s: string, kids = false) => b(id, "paragraph", { rich_text: [rt(s)] }, kids);
const bullet = (id: string, s: string, kids = false) => b(id, "bulleted_list_item", { rich_text: [rt(s)] }, kids);

// tree: block id → the blocks it serves. `paged` ids are served in two pages, to prove exhaustion.
const transport = (tree: Record<string, NotionBlock[]>, paged: string[] = []) => {
	const calls: string[] = [];
	const page = async (blockId: string, cursor?: string): Promise<BlockPage> => {
		calls.push(cursor ? `${blockId}@${cursor}` : blockId);
		const all = tree[blockId] ?? [];
		if (!paged.includes(blockId)) return { results: all, has_more: false, next_cursor: null };
		return cursor
			? { results: all.slice(1), has_more: false, next_cursor: null }
			: { results: all.slice(0, 1), has_more: true, next_cursor: "cur" };
	};
	return { page, calls };
};

test("renders the block kinds a prompt body uses", async () => {
	const { page } = transport({
		root: [
			b("h", "heading_2", { rich_text: [rt("Who we are")] }),
			para("p", "plain prose"),
			bullet("l1", "first"),
			bullet("l2", "second"),
			b("t", "to_do", { checked: true, rich_text: [rt("done")] }),
			b("d", "divider", {}),
			b("c", "code", { language: "json", rich_text: [rt('{"a":1}')] })
		]
	});
	assert.equal(
		await bodyOf("root", page),
		'## Who we are\n\nplain prose\n\n- first\n- second\n\n- [x] done\n\n---\n\n```json\n{"a":1}\n```'
	);
});

// A blank line is not a block: Notion stores a list of blocks, so the ONLY thing that can preserve the
// space an author left between two lists is this join. Items of one list are one list; a bullet list
// and a numbered list are two, and gluing them reflows prose nobody asked to reflow.
test("two lists of different kinds keep the blank line between them; one list stays one list", async () => {
	const { page } = transport({
		root: [
			bullet("b1", "first"),
			bullet("b2", "second"),
			b("n1", "numbered_list_item", { rich_text: [rt("step one")] }),
			b("n2", "numbered_list_item", { rich_text: [rt("step two")] }),
			b("t1", "to_do", { checked: false, rich_text: [rt("todo")] })
		]
	});
	assert.equal(
		await bodyOf("root", page),
		"- first\n- second\n\n1. step one\n1. step two\n\n- [ ] todo"
	);
});

test("carries inline annotations and links through as markdown", async () => {
	const { page } = transport({
		root: [
			b("p", "paragraph", {
				rich_text: [rt("judge the "), rt("soft", { bold: true }), rt(" criteria in "), rt("qualify", { code: true }), rt(" — see "), rt("docs", {}, "https://x.dev")]
			})
		]
	});
	assert.equal(await bodyOf("root", page), "judge the **soft** criteria in `qualify` — see [docs](https://x.dev)");
});

test("keeps an unknown block's text rather than dropping it", async () => {
	const { page } = transport({ root: [b("x", "table_of_contents", { rich_text: [rt("kept")] })] });
	assert.equal(await bodyOf("root", page), "kept");
});

test("drops empty blocks — an empty paragraph IS the blank line", async () => {
	const { page } = transport({ root: [para("a", "one"), b("gap", "paragraph", { rich_text: [] }), para("b", "two")] });
	assert.equal(await bodyOf("root", page), "one\n\ntwo");
});

test("reads every page, so a body is never silently truncated", async () => {
	const { page, calls } = transport({ root: [para("a", "one"), para("b", "two")] }, ["root"]);
	assert.equal(await bodyOf("root", page), "one\n\ntwo");
	assert.deepEqual(calls, ["root", "root@cur"]); // followed the cursor rather than stopping at page 1
});

test("nests real children one level", async () => {
	const { page } = transport({ root: [bullet("outer", "Who:", true)], outer: [bullet("inner", "a former PM")] });
	assert.equal(await bodyOf("root", page), "- Who:\n  - a former PM");
});

test("splices a synced ORIGINAL at its own level, not nested", async () => {
	const { page } = transport({
		root: [para("intro", "You qualify leads."), b("sync", "synced_block", { synced_from: null }, true)],
		sync: [b("h", "heading_2", { rich_text: [rt("Company")] }), para("p", "Reduck makes it trivial.")]
	});
	assert.equal(await bodyOf("root", page), "You qualify leads.\n\n## Company\n\nReduck makes it trivial.");
});

test("splices a synced REFERENCE the same way — the shared copy reads as if inline", async () => {
	// The reference has no rich_text and points at the original; its own children endpoint serves the
	// original's blocks (live-API behaviour), so the reader needs no resolve step.
	const { page } = transport({
		root: [
			b("head", "heading_2", { rich_text: [rt("Who we are")] }),
			b("ref", "synced_block", { synced_from: { type: "block_id", block_id: "original" } }, true),
			b("icp", "heading_2", { rich_text: [rt("ICP")] })
		],
		ref: [para("p1", "Reduck makes it trivial."), para("p2", "Reduck already helps vertical leaders.")]
	});
	assert.equal(
		await bodyOf("root", page),
		"## Who we are\n\nReduck makes it trivial.\n\nReduck already helps vertical leaders.\n\n## ICP"
	);
});

test("a synced block inside a list nests ONE level, never two", async () => {
	// The regression that motivated TRANSPARENT: two levels is four spaces, and four spaces turns the
	// shared section's heading into a code block — silently corrupting the instructions.
	const { page } = transport({
		root: [bullet("outer", "Context:", true)],
		outer: [b("ref", "synced_block", { synced_from: { type: "block_id", block_id: "o" } }, true)],
		ref: [b("h", "heading_3", { rich_text: [rt("Company")] }), para("p", "Reduck makes it trivial.")]
	});
	const md = await bodyOf("root", page);
	assert.equal(md, "- Context:\n  ### Company\n\n  Reduck makes it trivial.");
	assert.ok(!/^ {4}/m.test(md), "no line may reach four spaces of indent");
});

test("blank lines inside a nested subtree carry no trailing whitespace", async () => {
	const { page } = transport({
		root: [bullet("outer", "Context:", true)],
		outer: [para("a", "one"), para("b", "two")]
	});
	assert.equal(await bodyOf("root", page), "- Context:\n  one\n\n  two");
});

test("an empty page is an empty document, not an error", async () => {
	const { page } = transport({ root: [] });
	assert.equal(await bodyOf("root", page), "");
});

// --- shared-section markers ----------------------------------------------------------------------
// These used to serve Notion synced blocks; they now serve the local prompt tree (src/prompts.ts),
// where a marker names a POOL FILE instead of a block id. The syntax was always the contract and the
// id's shape never was, so nothing here changed but what the names mean. Two functions, one document:
// `segmentsOf` says where a shared region begins and ends (the check and the re-inline read it), and
// `compileAuthoring` drops the markers to give the model the prose alone.

const MARKED =
	"## Who we are\n\n" +
	"<!-- shared:company -->\n" +
	"Reduck makes it trivial.\n\nReduck already helps vertical leaders.\n" +
	"<!-- /shared:company -->\n\n## ICP";

test("compileAuthoring drops the marker lines and nothing else", () => {
	assert.equal(
		compileAuthoring(MARKED),
		"## Who we are\n\nReduck makes it trivial.\n\nReduck already helps vertical leaders.\n\n## ICP"
	);
});

test("segmentsOf splits the document at its seams, own prose and shared regions in order", () => {
	assert.deepEqual(segmentsOf(MARKED), [
		{ text: "## Who we are\n" },
		{ shared: "company", text: "Reduck makes it trivial.\n\nReduck already helps vertical leaders." },
		{ text: "\n## ICP" }
	]);
});

test("the label after the name is cosmetic — a marker still names the same region", () => {
	const hinted = MARKED.replace(
		"<!-- shared:company -->",
		'<!-- shared:company — authored on "prompts/company.md"; edit it there, not here -->'
	);
	assert.equal(compileAuthoring(hinted), compileAuthoring(MARKED));
	assert.deepEqual(segmentsOf(hinted), segmentsOf(MARKED));
});

test("a nested region reads fine but refuses to publish", () => {
	// An indented marker means the region sits inside another block. Reading is fine (compileAuthoring
	// trims before matching); re-inlining it would have to rebuild the nesting around it, so segmentsOf
	// refuses rather than hoist shared prose out of the block that framed it.
	const nested = "- Context:\n  <!-- shared:company -->\n  Reduck makes it trivial.\n  <!-- /shared:company -->";
	assert.equal(compileAuthoring(nested), "- Context:\n  Reduck makes it trivial.");
	assert.throws(() => segmentsOf(nested), /nested \(indented\)/);
});

test("segmentsOf is loud on mis-delimited documents, never a silent fork", () => {
	assert.throws(() => segmentsOf(`<!-- shared:company -->\nprose`), /never closed/);
	assert.throws(() => segmentsOf(`<!-- /shared:company -->`), /never opened/);
	assert.throws(
		() => segmentsOf(`<!-- shared:company -->\nprose\n<!-- /shared:reddit-context -->`),
		/mismatched markers/
	);
});
