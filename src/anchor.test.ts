// anchor invariants: absent → null, unique → bare exact, repeated → minimal context that
// re-locates to exactly one span, and validate is loud on a paraphrase.
// Run: npm run build && node --test dist/src/anchor.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, resolveVisible, validate } from "./anchor.js";

const ev =
	"### About\n\nFounding PM at AgentAchieve. Based in San Francisco Bay Area.\n\n### Now\n\nVP at Automation Anywhere, San Francisco Bay Area.";

test("absent quote → null", () => {
	assert.equal(resolve(ev, "Chief Robot Officer"), null);
});

test("unique quote → bare exact, no context", () => {
	assert.deepEqual(resolve(ev, "Founding PM at AgentAchieve"), {
		exact: "Founding PM at AgentAchieve"
	});
});

test("repeated quote → carries minimal context and re-locates uniquely", () => {
	const q = "San Francisco Bay Area"; // appears twice
	const sel = resolve(ev, q)!;
	assert.equal(sel.exact, q);
	assert.ok(sel.prefix || sel.suffix, "a repeated quote must carry disambiguating context");
	const triple = (sel.prefix ?? "") + sel.exact + (sel.suffix ?? "");
	assert.equal(
		ev.split(triple).length - 1,
		1,
		"the prefix+exact+suffix triple must occur exactly once"
	);
});

test("validate throws on a paraphrase and names it", () => {
	assert.throws(
		() =>
			validate(ev, [
				{ claim: "x", supporting: true, quotes: ["totally not in the evidence"] }
			]),
		/not found verbatim/
	);
});

test("validate throws on a statement with no quote and names it", () => {
	assert.throws(
		() => validate(ev, [{ claim: "unbacked", supporting: false, quotes: [] }]),
		/no quote/
	);
});

test("validate resolves a good set to Selectors, stance intact", () => {
	const out = validate(ev, [
		{ claim: "founder", supporting: true, quotes: ["Founding PM at AgentAchieve"] }
	]);
	assert.deepEqual(out, [
		{ claim: "founder", supporting: true, quotes: [{ exact: "Founding PM at AgentAchieve" }] }
	]);
});

// resolveVisible — the human seam: a DOM selection (rendered view, whitespace collapsed and
// markdown syntax stripped) maps back to a verbatim SOURCE span, so it can cross bold labels
// and block boundaries.
const experiences =
	"### Experiences\n\n- **title:** Director of Product Management, AI\n  **company:** Automation Anywhere\n  **duration:** 3 yrs 4 mos";

test("visible selection spanning bold labels → a raw source span with `**` preserved", () => {
	const sel = resolveVisible(experiences, "title: Director of Product Management, AI company: Automation Anywhere")!;
	assert.ok(sel, "must anchor across the label boundary");
	// the stored exact is the raw source slice — syntax re-included — and re-locates verbatim
	assert.match(sel.exact, /\*\*company:\*\*/);
	assert.equal(experiences.split(sel.exact).length - 1, 1, "the span re-locates to exactly one occurrence");
	assert.ok(resolve(experiences, sel.exact), "resolve finds the returned span");
});

test("visible selection crossing a `> ` blockquote line resolves", () => {
	const activity = "**Posted**\n> **Jane Doe** · CEO\n> Scaling our platform to 1,000 customers.";
	const sel = resolveVisible(activity, "Jane Doe · CEO Scaling our platform to 1,000 customers.")!;
	assert.ok(sel, "must anchor across the blockquote lines");
	assert.equal(activity.split(sel.exact).length - 1, 1);
});

test("a bare value / prose selection still resolves (no regression)", () => {
	assert.deepEqual(resolveVisible(experiences, "Automation Anywhere"), { exact: "Automation Anywhere" });
	assert.deepEqual(resolveVisible(ev, "Founding PM at AgentAchieve"), { exact: "Founding PM at AgentAchieve" });
});

test("genuinely-absent visible text → null", () => {
	assert.equal(resolveVisible(experiences, "Chief Robot Officer"), null);
});
