// factsOf — the markup facts kept when the markup is thrown away. The fixture carries every shape
// the extractor claims to handle: a canonical (attributes in either order), a JSON-LD block with an
// @graph, a second block that is malformed (must not take down the first), an og fallback date, and
// headings.

import { test } from "node:test";
import assert from "node:assert/strict";
import { factsOf } from "./http.js";

const PAGE = `<!doctype html><html><head>
<link href="https://example.com/post" rel="canonical">
<meta property="article:published_time" content="2026-01-01T00:00:00Z">
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"BlogPosting","datePublished":"2026-03-23T09:00:00Z"},
  {"@type":["WebPage","FAQPage"]},
  {"@type":"BreadcrumbList"}
]}
</script>
<script type="application/ld+json">{not json at all</script>
</head><body>
<h1>Title</h1><h2>A</h2><h2 class="x">B</h2><h3>a</h3>
<p>h2 in prose does not count, nor does &lt;h2&gt;</p>
</body></html>`;

test("factsOf reads canonical, JSON-LD (with @graph, arrays, malformed blocks), dates and headings", () => {
	const f = factsOf(PAGE);
	assert.equal(f.canonical, "https://example.com/post");
	// JSON-LD's own claim wins over the og fallback.
	assert.equal(f.published, "2026-03-23T09:00:00Z");
	assert.deepEqual([...f.schemaTypes].sort(), ["BlogPosting", "BreadcrumbList", "FAQPage", "WebPage"]);
	assert.equal(f.h2, 2);
	assert.equal(f.h3, 1);
});

test("factsOf on a page declaring nothing answers nothing — never throws", () => {
	const f = factsOf("<html><body>Just a moment…</body></html>");
	assert.deepEqual(f, { canonical: null, published: null, schemaTypes: [], h2: 0, h3: 0 });
});

test("factsOf falls back to og:article:published_time when JSON-LD carries no date", () => {
	const f = factsOf(`<meta property="article:published_time" content="2026-01-01">`);
	assert.equal(f.published, "2026-01-01");
});
