// The prompt tree, checked. Prompts are files now, so what used to be enforced by a publish path
// (a publish step refusing to fork a shared section) has to be enforced by a checker — this is it,
// and it is a TEST rather than a script because `npm test` is the gate that already exists.
// It is the same check set anthropics/financial-services' check.py runs over its vendored skills:
// the copy matches its source, every reference resolves, and the manifest agrees with the tree.
// Run: npm run build && node --test dist/src/prompts.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Ajv } from "ajv";
import { AGENTS } from "../agents/index.js";
import { fingerprint, listPool, listPrompts, loadPrompt, poolPath, syncPrompts } from "./prompts.js";

// 1. THE COPY MATCHES ITS SOURCE. A section several prompts share is authored once in the pool and
// inlined into each of them, so the file on disk is the whole prompt — and an inlined copy can be
// edited in place, which forks it away from the source and from every other prompt reading it,
// silently. `syncPrompts` re-derives what each region SHOULD say; drift is any difference.
test("no prompt has drifted from the shared pool", async () => {
	const drifted = (await syncPrompts()).filter((p) => p.drifted.length);
	assert.deepEqual(
		drifted.map((p) => `${p.agent}/${p.key}: ${p.drifted.join(", ")}`),
		[],
		"run `sflock prompts` to re-inline these from prompts/<name>.md (the pool file is the source)"
	);
});

// 2. EVERY PROMPT IS COMPLETE AND ITS CONTRACT IS REAL. A prompt is three files; a missing or
// malformed one is a broken contract, and the judge would meet it mid-run instead of here.
test("every prompt has instructions and two schemas that compile", async () => {
	const ajv = new Ajv();
	for (const p of await listPrompts()) {
		const c = await loadPrompt(p.agent, p.key);
		assert.ok(c.body.length > 0, `${p.agent}/${p.key}: empty instructions`);
		for (const [which, schema] of [
			["input", c.inputSchema],
			["output", c.outputSchema]
		] as const)
			assert.doesNotThrow(
				() => ajv.compile(schema),
				`${p.agent}/${p.key}: ${which}.json is not a schema ajv can compile`
			);
	}
});

// 3. THE TREE AND THE ROSTER AGREE, BOTH WAYS. A declared prompt with no folder fails at judgment
// time; a folder no config declares is prose nothing will ever read. Neither is visible without
// asking the question from both sides.
test("config.prompts and the prompt folders are the same set", async () => {
	const onDisk = new Set((await listPrompts()).map((p) => `${p.agent}/${p.key}`));
	const declared = new Set(
		Object.values(AGENTS).flatMap((a) => Object.keys(a.config.prompts ?? {}).map((k) => `${a.id}/${k}`))
	);
	assert.deepEqual([...declared].filter((k) => !onDisk.has(k)), [], "declared in config.ts, no folder");
	assert.deepEqual([...onDisk].filter((k) => !declared.has(k)), [], "folder on disk, not in config.ts");
});

// 4. EVERY REFERENCE RESOLVES, AND NOTHING IN THE POOL IS DEAD. `syncPrompts` already throws on a
// marker naming a pool file that does not exist (a reference that does not resolve); the other
// direction is the one nobody notices — a fragment every prompt stopped inlining still reads like
// live prose, and someone will edit it expecting an effect.
test("every pool fragment is used by at least one prompt", async () => {
	const used = new Set((await syncPrompts()).flatMap((p) => p.regions));
	assert.deepEqual((await listPool()).filter((name) => !used.has(name)), [], "unused pool fragment");
});

// 5. THE PIN COVERS THE WHOLE CONTRACT. A Decision pins `fingerprint` beside its Model to answer
// "which wording ruled" — so it must move when ANY of the three parts moves. Measured failure this
// guards: when the hash covered the body alone, a required Output field added mid-batch retroactively
// invalidated 9 judged rows with nothing flagging it.
test("the fingerprint pins instructions AND both schemas", () => {
	const parts = ["judge the thread", `{"type":"object"}`, `{"type":"object","required":["tier"]}`];
	const pinned = fingerprint(...parts);
	assert.equal(pinned, fingerprint(...parts)); // deterministic while nothing changes
	for (let i = 0; i < parts.length; i++) {
		const edited = [...parts];
		edited[i] += " ";
		assert.notEqual(fingerprint(...edited), pinned, `part ${i} does not move the hash`);
	}
});

// 6. THE MODEL NEVER SEES THE SEAMS. The file keeps its markers (that is what makes it authorable and
// checkable); the body handed to the judge must not, and the shared prose between them must survive —
// this is the one place those two requirements are asserted together.
test("the loaded body drops the markers and keeps the prose", async () => {
	for (const state of await syncPrompts()) {
		const { body } = await loadPrompt(state.agent, state.key);
		const where = `${state.agent}/${state.key}`;
		assert.ok(!/<!--\s*\/?shared:/.test(body), `${where}: a marker reached the model`);
		const raw = await readFile(state.path, "utf8");
		for (const name of state.regions) {
			const fragment = (await readFile(poolPath(name), "utf8")).trim();
			assert.ok(raw.includes(fragment), `${where}: ${name} is not inlined in the file`);
			assert.ok(body.includes(fragment), `${where}: ${name} did not survive into the body`);
		}
	}
});
