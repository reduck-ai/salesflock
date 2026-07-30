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
	describe: nope,
	upsert: nope,
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

const reviewer = createReviewer({ config, renderEvidence: () => "", store });
const hash = () => reviewer.instructionsHash("Q");

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
});
