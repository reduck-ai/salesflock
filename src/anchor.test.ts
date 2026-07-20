// anchor invariants: a quote is a [start,end) range into E; its text is E.slice(start,end);
// inRange gates a write; a human selection resolves to the occurrence nearest its position.
// Run: npm run build && node --test dist/src/anchor.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	quoteText,
	quoteKey,
	inRange,
	collectQuotes,
	canonicalize,
	quoteAt,
	annotate,
	snapQuote
} from "./anchor.js";

const ev =
	"### About\n\nFounding PM at AgentAchieve. Based in San Francisco Bay Area.\n\n### Now\n\nVP at Automation Anywhere, San Francisco Bay Area.";

test("quoteText slices E; quoteKey is the span", () => {
	const q = { start: 11, end: 38 };
	assert.equal(quoteText(ev, q), "Founding PM at AgentAchieve");
	assert.equal(quoteKey(q), "11:38");
});

test("inRange gates the bounds", () => {
	assert.ok(inRange(ev, { start: 0, end: ev.length }));
	assert.ok(!inRange(ev, { start: 5, end: ev.length + 1 }));
	assert.ok(!inRange(ev, { start: 10, end: 3 }));
	assert.ok(!inRange(ev, { start: 1.5, end: 4 }));
});

test("collectQuotes gathers every quotes[] in a verdict (statements + nested output)", () => {
	const quotes = collectQuotes({
		output: { action: "comment", quotes: [{ start: 1, end: 2 }] },
		statements: [{ claim: "c", supporting: true, quotes: [{ start: 3, end: 4 }] }]
	});
	assert.equal(quotes.length, 2);
	assert.deepEqual(new Set(quotes.map(quoteKey)), new Set(["1:2", "3:4"]));
});

test("quoteAt: unique selection → its exact range", () => {
	const q = quoteAt(ev, "Founding PM at AgentAchieve", 0)!;
	assert.ok(q);
	assert.equal(quoteText(ev, q), "Founding PM at AgentAchieve");
});

test("quoteAt: a repeated selection resolves to the occurrence nearest the cursor", () => {
	const phrase = "San Francisco Bay Area"; // appears twice
	const { canon } = canonicalize(ev);
	const near = quoteAt(ev, phrase, 0)!; // cursor near the top → first occurrence
	const far = quoteAt(ev, phrase, canon.length)!; // cursor near the end → second occurrence
	assert.equal(quoteText(ev, near), phrase);
	assert.equal(quoteText(ev, far), phrase);
	assert.ok(near.start < far.start, "position picks distinct occurrences");
});

test("quoteAt: absent text → null", () => {
	assert.equal(quoteAt(ev, "Chief Robot Officer", 0), null);
});

// the visible seam: a selection spanning bold labels / block markers maps to a RAW range whose
// slice re-includes the stripped syntax verbatim.
const experiences =
	"### Experiences\n\n- **title:** Director of Product Management, AI\n  **company:** Automation Anywhere\n  **duration:** 3 yrs 4 mos";

test("quoteAt across bold labels → a raw range with `**` preserved, located once", () => {
	const q = quoteAt(
		experiences,
		"title: Director of Product Management, AI company: Automation Anywhere",
		0
	)!;
	assert.ok(q, "must anchor across the label boundary");
	const text = quoteText(experiences, q);
	assert.match(text, /\*\*company:\*\*/);
	assert.equal(experiences.split(text).length - 1, 1, "the range's text occurs once");
});

test("quoteAt across a `> ` blockquote line resolves", () => {
	const activity = "**Posted**\n> **Jane Doe** · CEO\n> Scaling our platform to 1,000 customers.";
	const q = quoteAt(activity, "Jane Doe · CEO Scaling our platform to 1,000 customers.", 0)!;
	assert.ok(q, "must anchor across the blockquote lines");
	assert.match(quoteText(activity, q), /Scaling our platform/);
});

// annotate — the judge's position landmarks: markers strip back to the original, and each ⟨N⟩
// names the offset of the very next character.
test("annotate: strips back to the original, and each ⟨N⟩ marks the next char's offset", () => {
	const a = annotate(ev, 30);
	assert.equal(a.replace(/⟨\d+⟩/g, ""), ev, "markers must be removable to recover E exactly");
	for (const m of a.matchAll(/⟨(\d+)⟩(.)/g)) {
		const n = Number(m[1]);
		assert.equal(m[2], ev[n], `the char after ⟨${n}⟩ must be E[${n}]`);
	}
});

// snapQuote — the offset-correction post-step. A judge quote lands near its text; snap pins it
// onto the rendered occurrence (absorbing `**`/whitespace) and returns a raw span that renders to it.
test("snapQuote: corrects a near-miss onto its own intended_text", () => {
	const true0 = ev.indexOf("San Francisco Bay Area");
	const q = { start: true0 + 9, end: true0 + 31, intended_text: "San Francisco Bay Area" };
	const s = snapQuote(ev, q);
	assert.equal(quoteText(ev, s), "San Francisco Bay Area");
	assert.equal(s.intended_text, "San Francisco Bay Area");
});

test("snapQuote: absorbs `**` — a rendered quote maps to the raw span carrying the syntax", () => {
	const md = "### Activity\n\n↳ **replied** · 4w: Carl Hillier closed it.";
	const near = md.indexOf("replied");
	const s = snapQuote(md, { start: near + 12, end: near + 30, intended_text: "replied · 4w: Carl Hillier closed it." });
	// the raw span re-includes the stripped `**`, and renders (canon) back to the quote
	assert.match(quoteText(md, s), /replied\*\* · 4w: Carl Hillier closed it\./);
});

test("snapQuote: anchors a quote that copied RAW markdown (bullets + `**`)", () => {
	const exp = "### Experiences\n\n- **title:** Group Product Manager\n  **company:** SS&C Blue Prism";
	const near = exp.indexOf("Group");
	// the judge copied the raw markdown, offset a bit off
	const s = snapQuote(exp, {
		start: near + 7,
		end: near + 40,
		intended_text: "- **title:** Group Product Manager\n  **company:** SS&C Blue Prism"
	});
	assert.match(quoteText(exp, s), /Group Product Manager/);
	assert.match(quoteText(exp, s), /SS&C Blue Prism/);
});

test("snapQuote: a human quote (no intended_text) is left untouched", () => {
	const q = { start: 11, end: 38 };
	assert.deepEqual(snapQuote(ev, q), q);
});

test("snapQuote: out-of-window text is not snapped (no global guess)", () => {
	const q = { start: 0, end: 22, intended_text: "San Francisco Bay Area" }; // real occurrence is far later
	assert.deepEqual(snapQuote(ev, q, 10), q);
});
