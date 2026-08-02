// The prompt store — files, not rows. A prompt is a FOLDER, `agents/<id>/prompts/<key>/`, holding one
// artifact per file: `PROMPT.md` (the instructions, pure prose), `input.json` / `output.json` (its
// contract, JSON Schema at the root so an editor validates them), and `ground_truth.yaml` (the corpus
// that proves it, read by src/eval.ts). Git is the version: a diff is the review, `git log -S` is the
// history, and a Decision still pins `fingerprint` so "which wording ruled" survives every edit.
//
// SHARED PROSE IS INLINED, NOT IMPORTED — the one design decision here. A section reused by several
// prompts is authored once in the flat pool (`prompts/<name>.md`, where the NAME is the identity) and
// copied INTO each prompt between the codec's markers:
//
//     <!-- shared:company -->
//     Reduck makes it trivial to …
//     <!-- /shared:company -->
//
// So the file on disk IS the prompt: nothing resolves at read time, a git diff shows the words that
// actually changed, and a candidate handed to `sflock eval` is complete on its own. The cost of a copy
// is drift, and that is what `syncPrompts` is for — one function, three faces: `sflock prompts sync`
// rewrites every region from the pool, `--check` reports instead, and src/prompts.test.ts asserts the
// check is empty, so drift is a red test on the gate that already exists.
//
// No new syntax and no new parser: `SHARED`, `segmentsOf` and `compileAuthoring` are the codec's
// (src/stores/notion.codec.ts), whose own header says the marker's id shape was never part of its
// contract — so a pool name slots straight in where a Notion block id used to be.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { SHARED, compileAuthoring, segmentsOf } from "./stores/notion.codec.js";

// The repo root, resolved from THIS module rather than from cwd: `sflock` must work from anywhere,
// and the test runner's cwd is nobody's business. dist/src/prompts.js → ../../ → salesflock/.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const poolPath = (name: string): string => join(ROOT, "prompts", `${name}.md`);
export const promptDir = (agentId: string, key: string): string =>
	join(ROOT, "agents", agentId, "prompts", key);

// fingerprint(contract) — WHICH wording a judgment ran under, pinned on the Decision beside its Model.
// It covers the whole contract (instructions + both schemas), so "a change is a new fingerprint" holds
// for every part of it: two Decisions citing one kind with different hashes were NOT judged alike.
// Short — this identifies a version, it does not defend against tampering.
export const fingerprint = (...parts: string[]): string =>
	createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 12);

// A kind's contract as the engine reads it. `body` is what the MODEL sees — the file with its marker
// lines dropped — while the file itself keeps them, which is the two-reader rule the Notion codec used
// to serve with two projections and now gets for free: the authoring view is the file.
export interface Contract {
	key: string; // the config.prompts key, which IS the folder name
	dir: string;
	hash: string;
	body: string;
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
}

const read = async (path: string): Promise<string> => {
	const text = await readFile(path, "utf8").catch(() => {
		throw new Error(`no ${path} — a prompt is a folder: PROMPT.md, input.json, output.json`);
	});
	if (!text.trim()) throw new Error(`${path} is empty`);
	return text;
};

const schemaOf = (raw: string, path: string): Record<string, unknown> => {
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch (e) {
		throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
	}
};

// Resolved ONCE per process: a contract is invariant while a run lasts, and re-reading it per judged
// item was "shared context computed once" (README #7) broken in the most expensive way available. It
// is also a CORRECTNESS fix — one run is one contract, so an edit landing mid-batch cannot split a
// batch across two of them. A failure is not cached: it would poison the process.
const cache = new Map<string, Promise<Contract>>();
export const loadPrompt = (agentId: string, key: string): Promise<Contract> => {
	const id = `${agentId}/${key}`;
	const hit = cache.get(id);
	if (hit) return hit;
	const flight = resolve(agentId, key).catch((e: unknown) => {
		cache.delete(id);
		throw e;
	});
	cache.set(id, flight);
	return flight;
};

const resolve = async (agentId: string, key: string): Promise<Contract> => {
	const dir = promptDir(agentId, key);
	const [markdown, input, output] = await Promise.all([
		read(join(dir, "PROMPT.md")),
		read(join(dir, "input.json")),
		read(join(dir, "output.json"))
	]);
	const body = compileAuthoring(markdown).trim();
	if (!body) throw new Error(`${join(dir, "PROMPT.md")} carries no instructions`);
	return {
		key,
		dir,
		// The RAW schema text, never a re-serialization: a fingerprint must not move because a
		// pretty-printer changed its mind about whitespace.
		hash: fingerprint(body, input, output),
		body,
		inputSchema: schemaOf(input, join(dir, "input.json")),
		outputSchema: schemaOf(output, join(dir, "output.json"))
	};
};

// Every prompt folder in the repo — the walk `sync` and the test share, so neither can check a set the
// other doesn't. Agent-agnostic by construction: it reads the tree, not a roster.
export const listPrompts = async (): Promise<{ agent: string; key: string; path: string }[]> => {
	const out: { agent: string; key: string; path: string }[] = [];
	for (const agent of await readdir(join(ROOT, "agents"), { withFileTypes: true })) {
		if (!agent.isDirectory()) continue;
		const dir = join(ROOT, "agents", agent.name, "prompts");
		const keys = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const k of keys)
			if (k.isDirectory()) out.push({ agent: agent.name, key: k.name, path: join(dir, k.name, "PROMPT.md") });
	}
	return out.sort((a, b) => `${a.agent}/${a.key}`.localeCompare(`${b.agent}/${b.key}`));
};

// rewrite(markdown, pool) — every shared region's content replaced by the pool's. Line-based and
// surgical: everything OUTSIDE a region is passed through byte for byte, so a sync can only ever
// change the words it is supposed to. (Rebuilding the document from `segmentsOf` would be shorter and
// wrong — it drops a segment that is only whitespace, which is exactly the blank line between two
// adjacent regions.)
const rewrite = (markdown: string, pool: Map<string, string>): string => {
	const out: string[] = [];
	let open: string | undefined;
	for (const line of markdown.split("\n")) {
		const m = SHARED.exec(line.trim());
		if (!m) {
			if (!open) out.push(line); // inside a region, the file's own copy is dropped
			continue;
		}
		if (m[1]) {
			out.push(...pool.get(open!)!.split("\n"), line);
			open = undefined;
		} else {
			out.push(line);
			open = m[2];
		}
	}
	return out.join("\n");
};

export interface PromptState {
	agent: string;
	key: string;
	path: string;
	hash: string;
	regions: string[];
	drifted: string[]; // pool names whose copy here differs from the source
}

// syncPrompts({apply}) — the ONE drift function, and the whole tooling budget. It reads every prompt,
// compares each inlined region against its pool file, and either rewrites the file (`apply`) or just
// reports (`--check`, and the test). Loud on a region naming a pool file that does not exist: that is
// a reference that does not resolve, which is the other half of what a checker is for.
export const syncPrompts = async ({ apply = false } = {}): Promise<PromptState[]> => {
	const pool = new Map<string, string>();
	const fragment = async (name: string): Promise<string> => {
		const hit = pool.get(name);
		if (hit !== undefined) return hit;
		const text = (
			await readFile(poolPath(name), "utf8").catch(() => {
				throw new Error(`shared region "${name}" has no source — expected ${poolPath(name)}`);
			})
		).trim();
		pool.set(name, text);
		return text;
	};

	const states: PromptState[] = [];
	for (const p of await listPrompts()) {
		const markdown = await read(p.path);
		const regions: string[] = [];
		const drifted: string[] = [];
		// segmentsOf owns the region BOUNDS (and is loud on a marker that never closes, closes the wrong
		// region, or is nested) — so the comparison and the rewrite read the same delimiters.
		for (const seg of segmentsOf(markdown)) {
			if (!seg.shared) continue;
			regions.push(seg.shared);
			if (seg.text.trim() !== (await fragment(seg.shared))) drifted.push(seg.shared);
		}
		if (apply && drifted.length) await writeFile(p.path, rewrite(markdown, pool));
		const { hash } = await loadPrompt(p.agent, p.key);
		states.push({ ...p, hash, regions, drifted });
	}
	return states;
};

// Every shared section in the pool — what a marker may name, and (via the test) what must be named
// by something. A SCREAMING-CASE basename is a document about the folder rather than a section in it
// (CLAUDE.md, README.md — the same convention that makes PROMPT.md obvious in a prompt folder), so
// it is not a fragment: nothing may inline it, and nothing needs to.
export const listPool = async (): Promise<string[]> =>
	(await readdir(join(ROOT, "prompts")))
		.filter((f) => f.endsWith(".md") && !/^[A-Z0-9_]+\.md$/.test(f))
		.map((f) => f.replace(/\.md$/, ""))
		.sort();
