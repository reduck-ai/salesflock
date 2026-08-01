// The pin invariant: a Decision's Instructions hash covers the WHOLE contract the judgment ran
// under — the prompt body AND its Input/Output schema columns — so an in-place edit to any of the
// three reads as stale (measured failure this guards: a required Output field added mid-batch
// retroactively invalidated 9 judged rows with nothing flagging it, because the hash then covered
// only the body). Run: npm run build && node --test dist/src/decide.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { createReviewer } from "./decide.js";
import type { AgentConfig, Row, Store } from "./stores/index.js";

// A fake store serving ONE live prompt row whose body + schema columns the test mutates between
// hash reads. Everything the reviewer doesn't touch throws — a test reaching further is a bug.
const prompt = {
	body: "judge the thread",
	input: `{"type":"object"}`,
	output: `{"type":"object","required":["tier"]}`
};
const nope = (): never => {
	throw new Error("not under test");
};
const store: Store = {
	query: async (): Promise<Row[]> => [
		{
			id: "p1",
			fields: { Name: "Q", Version: 1, "Input schema": prompt.input, "Output schema": prompt.output }
		}
	],
	body: async () => prompt.body,
	authoring: nope,
	describe: nope,
	upsert: nope,
	create: nope,
	read: nope,
	queryPage: nope,
	get: nope,
	title: nope,
	comment: nope,
	archive: nope
};

const config: AgentConfig = {
	destination: "notion",
	models: { Prompts: "P", Decisions: "D" },
	entity: "Thread",
	prompts: { q: { name: "Q", pending: "pending", resolve: () => ({ status: "s", advances: true }) } }
};

// A FRESH reviewer per read: a reviewer resolves a kind's contract once and holds it (one run = one
// contract, asserted below), so re-reading the live contract is what a new process does.
const hash = () => createReviewer({ config, renderEvidence: () => "", store }).instructionsHash("Q");

test("the hash pins body AND schema columns — any in-place edit reads as a different contract", async () => {
	const pinned = await hash();
	assert.equal(pinned, await hash()); // deterministic while nothing changes

	const edited = { ...prompt };
	prompt.output = `{"type":"object","required":["tier","reasoning"]}`; // the measured failure
	const afterSchema = await hash();
	assert.notEqual(afterSchema, pinned);

	prompt.output = edited.output; // schema reverted ⇒ the original hash comes back
	assert.equal(await hash(), pinned);

	prompt.body = "judge the thread, but differently"; // the case the old body-only hash caught
	assert.notEqual(await hash(), pinned);
	prompt.body = edited.body;

	prompt.input = `{"type":"object","required":["Thread"]}`; // the third column, same rule
	assert.notEqual(await hash(), pinned);
	prompt.input = edited.input;
});

// The other half of the pin: ONE reviewer resolves a kind's contract once, so every item it judges
// is judged under the same wording — an edit landing mid-batch can no longer split a batch across two
// contracts (the failure the hash was added to detect; this is it prevented rather than detected).
// It is also what keeps the per-item cost off the paged, recursive body read.
test("one reviewer is one contract — an edit mid-run does not change what it judges under", async () => {
	const reviewer = createReviewer({ config, renderEvidence: () => "", store });
	const pinned = await reviewer.instructionsHash("Q");
	const before = { ...prompt };
	prompt.body = "rewritten mid-batch";
	prompt.output = `{"type":"object","required":["tier","reasoning"]}`;
	assert.equal(await reviewer.instructionsHash("Q"), pinned); // held, not re-read
	assert.notEqual(await hash(), pinned); // a fresh reviewer sees the edit
	Object.assign(prompt, before);
});
