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
	authoringOf,
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
		'## Who we are\n\nplain prose\n\n- first\n- second\n- [x] done\n\n---\n\n```json\n{"a":1}\n```'
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

// --- the AUTHORING projection -------------------------------------------------------------------
// The second reader of the same tree. Its whole contract is one property — stripping the markers
// returns the inference projection byte for byte — so every case below asserts the round-trip, not
// just the marked-up text: that is what lets an author edit a candidate and an eval judge exactly
// what a push will publish.

const REF_TREE = {
	root: [
		b("head", "heading_2", { rich_text: [rt("Who we are")] }),
		b("ref", "synced_block", { synced_from: { type: "block_id", block_id: "original" } }, true),
		b("icp", "heading_2", { rich_text: [rt("ICP")] })
	],
	ref: [para("p1", "Reduck makes it trivial."), para("p2", "Reduck already helps vertical leaders.")]
};

test("authoringOf delimits a synced REFERENCE and reports it as a region", async () => {
	const { page } = transport(REF_TREE);
	const { markdown, regions } = await authoringOf("root", page, () => '"Company — Reduck"');
	assert.deepEqual(regions, [{ blockId: "ref", syncedFrom: "original" }]);
	assert.equal(
		markdown,
		"## Who we are\n\n" +
			'<!-- shared:original — authored on "Company — Reduck"; edit it there, not here -->\n' +
			"Reduck makes it trivial.\n\nReduck already helps vertical leaders.\n" +
			"<!-- /shared:original -->\n\n## ICP"
	);
});

test("stripping the markers returns the inference projection, byte for byte", async () => {
	const { page } = transport(REF_TREE);
	const { markdown } = await authoringOf("root", page, () => '"Company — Reduck"');
	assert.equal(compileAuthoring(markdown), await bodyOf("root", page));
});

test("the label is cosmetic — any hint round-trips and still names the same region", async () => {
	const { page } = transport(REF_TREE);
	const flat = await bodyOf("root", page);
	for (const label of [undefined, () => undefined, () => "anything at all -- with punctuation!"]) {
		const { markdown } = await authoringOf("root", page, label as never);
		assert.equal(compileAuthoring(markdown), flat);
		assert.deepEqual(
			segmentsOf(markdown).map((s) => s.shared ?? "own"),
			["own", "original", "own"]
		);
	}
});

test("a synced ORIGINAL is authored HERE, so it is never marked", async () => {
	const { page } = transport({
		root: [para("intro", "You qualify leads."), b("sync", "synced_block", { synced_from: null }, true)],
		sync: [para("p", "Reduck makes it trivial.")]
	});
	const { markdown, regions } = await authoringOf("root", page, () => "x");
	assert.deepEqual(regions, []);
	assert.equal(markdown, await bodyOf("root", page));
});

test("segmentsOf splits the document at its seams, own prose and shared regions in order", async () => {
	const { page } = transport(REF_TREE);
	const { markdown } = await authoringOf("root", page);
	assert.deepEqual(segmentsOf(markdown), [
		{ text: "## Who we are\n" },
		{ shared: "original", text: "Reduck makes it trivial.\n\nReduck already helps vertical leaders." },
		{ text: "\n## ICP" }
	]);
});

test("a nested region round-trips for reading but refuses to publish", async () => {
	// TRANSPARENT keeps a synced block inside a list at ONE level of indent, so its markers indent too.
	// Reading is fine (compileAuthoring trims before matching); writing it back would have to rebuild the
	// nesting, so segmentsOf refuses rather than hoist shared prose out of the block that framed it.
	const { page } = transport({
		root: [bullet("outer", "Context:", true)],
		outer: [b("ref", "synced_block", { synced_from: { type: "block_id", block_id: "o" } }, true)],
		ref: [para("p", "Reduck makes it trivial.")]
	});
	const { markdown } = await authoringOf("root", page, () => "shared page");
	assert.equal(compileAuthoring(markdown), await bodyOf("root", page));
	assert.throws(() => segmentsOf(markdown), /nested \(indented\)/);
});

test("segmentsOf is loud on mis-delimited documents, never a silent fork", async () => {
	const id = "3a84d7b7884c81f2a93ffe75f6dbc910";
	assert.throws(() => segmentsOf(`<!-- shared:${id} -->\nprose`), /never closed/);
	assert.throws(() => segmentsOf(`<!-- /shared:${id} -->`), /never opened/);
	assert.throws(
		() => segmentsOf(`<!-- shared:${id} -->\nprose\n<!-- /shared:${id.replace(/^3/, "4")} -->`),
		/mismatched markers/
	);
});
