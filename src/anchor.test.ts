// anchor invariants: absent → null, unique → bare exact, repeated → minimal context that
// re-locates to exactly one span, and validate is loud on a paraphrase.
// Run: npm run build && node --test dist/src/anchor.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, validate } from "./anchor.js";

const ev =
	"### About\n\nFounding PM at AgentAchieve. Based in San Francisco Bay Area.\n\n### Now\n\nVP at Automation Anywhere, San Francisco Bay Area.";

test("absent quote → null", () => {
	assert.equal(resolve(ev, "Chief Robot Officer"), null);
});

test("unique quote → bare exact, no context", () => {
	assert.deepEqual(resolve(ev, "Founding PM at AgentAchieve"), { exact: "Founding PM at AgentAchieve" });
});

test("repeated quote → carries minimal context and re-locates uniquely", () => {
	const q = "San Francisco Bay Area"; // appears twice
	const sel = resolve(ev, q)!;
	assert.equal(sel.exact, q);
	assert.ok(sel.prefix || sel.suffix, "a repeated quote must carry disambiguating context");
	const triple = (sel.prefix ?? "") + sel.exact + (sel.suffix ?? "");
	assert.equal(ev.split(triple).length - 1, 1, "the prefix+exact+suffix triple must occur exactly once");
});

test("validate throws on a paraphrase and names it", () => {
	assert.throws(
		() => validate(ev, [{ claim: "x", quotes: ["totally not in the evidence"] }]),
		/not found verbatim/
	);
});

test("validate resolves a good set to Selectors", () => {
	const out = validate(ev, [{ claim: "founder", quotes: ["Founding PM at AgentAchieve"] }]);
	assert.deepEqual(out, [{ claim: "founder", quotes: [{ exact: "Founding PM at AgentAchieve" }] }]);
});
