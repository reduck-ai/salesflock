#!/usr/bin/env node
// Offline eval of "Reddit Thread Qualification" against EVERY ./*_qualified_threads.yaml (the
// human-labeled ground truths — one file per subreddit digest; a candidate must win them ALL, or
// it just overfits the newest set). FAITHFUL to the runtime: evidence from the frozen Notion rows
// (projectInput → renderEvidence) and the same search_quotes/submit_claims two-tool loop as
// decide.ts — only the persistence is dropped and the instruction body is swappable.
//
//   node agents/reddit-engage/eval_qualify.mjs [candidate.md] [--only <id,id,…>]   (run from salesflock/)
//   — omit the file to eval the LIVE prompt body (the definitive check: real codec render).
//   — --only filters the ground truth to those thread ids, for tuning one case without paying for 35.
//
// A candidate may be either projection of a body: `sflock prompts edit` output (transclusion markers
// in) or a flat body. Markers are stripped before judging, so what this scores is exactly what
// `prompts push` would publish — a candidate cannot drift from the artifact it is qualifying.
//
// The tuning loop this drives:
//   1. `sflock prompts edit --agent reddit-engage qualify > candidate.md`, edit your OWN prose (the
//      delimited regions are authored on their own pages — the CLI prints which), then iterate here
//      until green — run it TWICE: gemini-3.5-flash at temp 0 is not run-stable on borderline
//      threads, so one green run proves nothing.
//   2. Don't overfit: rules state the PRINCIPLE ("would automating a browser fix this?"), never an
//      enumeration of the test set's surface domains; illustrative examples must come from
//      DIFFERENT domains than the ground-truth threads, or 35/35 just memorizes the 35.
//   3. Publish the winner: `sflock prompts push --agent reddit-engage qualify candidate.md` — a new
//      row at Version live+1, schema columns copied verbatim, shared sections written back as
//      references (and refused if you changed one). Then re-run this with no arg against the live body.
//   4. Inspect versions any time: `sflock prompts list/show --agent reddit-engage`.

import "../../dist/src/env.js";
import { readFileSync, readdirSync } from "node:fs";
import { parse } from "yaml";
import { getStore } from "../../dist/src/stores/index.js";
import { compileAuthoring } from "../../dist/src/stores/notion.codec.js";
import { createReviewer } from "../../dist/src/decide.js";
import { renderEvidence, fieldSpan } from "../../dist/agents/reddit-engage/evidence.js";
import { projectInput } from "../../dist/src/project.js";
import { threadUrl } from "../../dist/src/clients/reddit/index.js";
import { mapLimit } from "../../dist/src/concurrency.js";
import * as llm from "../../dist/src/ai/llm.js";
import { collectQuotes, findQuotes, inRange, quoteKey } from "../../dist/src/anchor.js";
import { schemaError } from "../../dist/src/output.js";
import config from "../../dist/agents/reddit-engage/config.js";

const store = getStore(config.destination);
const reviewer = createReviewer({ config, store, renderEvidence, fieldSpan });
const live = await reviewer.showPrompt("Reddit Thread Qualification");
const args = process.argv.slice(2);
const onlyAt = args.indexOf("--only");
const only = onlyAt < 0 ? null : new Set(args[onlyAt + 1].split(",").map((s) => s.trim()));
// The first bare arg that is not --only's VALUE. The `onlyAt >= 0` guard matters: without it, an
// absent --only (onlyAt = -1) excludes index 0 — silently dropping the candidate and evaluating the
// LIVE body while claiming to test the file. Measured, embarrassingly.
const candidate = args.find((a, i) => !a.startsWith("--") && !(onlyAt >= 0 && i === onlyAt + 1));
// A candidate is compiled the way `prompts push` compiles it, so the eval judges the shipping artifact.
const system = candidate ? compileAuthoring(readFileSync(candidate, "utf8")) : live.body;
console.error(`[eval] instructions: ${candidate ?? `live v${live.version} (${live.hash})`}`);
if (only) console.error(`[eval] --only ${[...only].join(",")}`);

const STATEMENTS = {
	type: "array",
	items: {
		type: "object",
		required: ["claim", "supporting", "quotes"],
		properties: {
			claim: { type: "string" },
			supporting: { type: "boolean" },
			quotes: {
				type: "array",
				items: { type: "object", required: ["start", "end"], properties: { start: { type: "integer" }, end: { type: "integer" } } }
			}
		}
	}
};

// decide.ts's loop, minus the write.
const judge = async (evidence) => {
	const responseSchema = {
		type: "object",
		required: ["output", "statements"],
		properties: { output: live.outputSchema, statements: STATEMENTS }
	};
	const returned = new Set();
	let submitted;
	const search_quotes = llm.jsonTool({
		description:
			"Locate verbatim quotes in the Evidence. Pass the exact text you intend to cite; get back, " +
			"per text, every occurrence as a {start,end} span with its surrounding `before`/`after` " +
			"context. When a quote occurs more than once, read the context and take the {start,end} of " +
			"the occurrence that fits your point. An empty match list means re-quote an exact substring.",
		schema: { type: "object", required: ["texts"], properties: { texts: { type: "array", items: { type: "string" } } } },
		execute: ({ texts }) =>
			texts.map((text) => ({
				text,
				matches: findQuotes(evidence, text).map((q) => {
					returned.add(quoteKey(q));
					return { start: q.start, end: q.end, before: evidence.slice(Math.max(0, q.start - 48), q.start), after: evidence.slice(q.end, q.end + 48) };
				})
			}))
	});
	const submit_claims = llm.jsonTool({
		description:
			"Commit the final judgment: the domain Output plus the claim→proof statements. Every quote " +
			"{start,end} must be one `search_quotes` returned — search for the text first, then submit that span.",
		schema: responseSchema,
		execute: (v) => {
			const err = schemaError(live.outputSchema, v.output);
			if (err) return { ok: false, error: `the Output does not satisfy its schema: ${err}` };
			const bad = collectQuotes(v).find((q) => !inRange(evidence, q) || !returned.has(quoteKey(q)));
			if (bad) return { ok: false, error: `quote ${quoteKey(bad)} was not returned by search_quotes — search for its text, then submit the span you got back.` };
			submitted = v;
			return { ok: true };
		}
	});
	const prompt = [system, `## Evidence\n\n${evidence}`].join("\n\n"); // examples: none exist (verified)
	await llm.agent(prompt, { search_quotes, submit_claims }, () => submitted !== undefined, config.model);
	if (!submitted) throw new Error("no valid decision within the step budget");
	return submitted;
};

const DIR = "agents/reddit-engage";
const files = readdirSync(DIR).filter((f) => f.endsWith("_qualified_threads.yaml"));
let allExact = 0;
let allGate = 0;
let total = 0;
for (const file of files) {
	const all = parse(readFileSync(`${DIR}/${file}`, "utf8"));
	const gt = only ? all.filter((t) => [...only].some((id) => t.url.includes(id))) : all;
	if (!gt.length) continue;
	const rows = await mapLimit(gt, async (t) => {
		const u = threadUrl(t.url);
		const row = await store.read(config.models.RedditThreads, "Thread URL", u);
		const input = projectInput(row.fields, live.inputSchema);
		const v = await judge(renderEvidence(input));
		return { id: u.match(/comments\/(\w+)/)[1], title: t.title.slice(0, 55), truth: t.tier, got: v.output.tier, claims: v.statements.map((s) => `${s.supporting ? "+" : "-"} ${s.claim}`) };
	});
	const exact = rows.filter((r) => r.got === r.truth).length;
	const gate = rows.filter((r) => (r.got === "No") === (r.truth === "No")).length;
	allExact += exact;
	allGate += gate;
	total += rows.length;
	console.log(`\n=== ${file}: exact ${exact}/${rows.length}, engage-vs-drop ${gate}/${rows.length} ===`);
	for (const r of rows) {
		console.log(`${r.got === r.truth ? "  " : "✗ "}${r.id}  truth=${r.truth.padEnd(3)} got=${String(r.got).padEnd(3)} ${r.title}`);
		if (r.got !== r.truth) for (const c of r.claims) console.log(`      ${c}`);
	}
}
console.log(`\n=== TOTAL: exact ${allExact}/${total}, engage-vs-drop ${allGate}/${total} ===`);
