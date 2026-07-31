#!/usr/bin/env node
// Offline eval of "Reddit Thread Qualification" against ./reddit_qualified_threads.yaml (the
// human-labeled ground truth). FAITHFUL to the runtime: evidence from the frozen Notion rows
// (projectInput → renderEvidence) and the same search_quotes/submit_claims two-tool loop as
// decide.ts — only the persistence is dropped and the instruction body is swappable.
//
//   node agents/reddit-engage/eval_qualify.mjs [candidate.md]   (run from salesflock/)
//   — omit the arg to eval the LIVE prompt body (the definitive check: real codec render).
//
// The tuning loop this drives:
//   1. Iterate a candidate .md locally until green — run it TWICE: gemini-3.5-flash at temp 0 is
//      not run-stable on borderline threads, so one green run proves nothing.
//   2. Don't overfit: rules state the PRINCIPLE ("would automating a browser fix this?"), never an
//      enumeration of the test set's surface domains; illustrative examples must come from
//      DIFFERENT domains than the ground-truth threads, or 15/15 just memorizes the 15.
//   3. Publish the winner as a NEW Prompt version (append-only — a new row, never an edit):
//      `ntn api /v1/pages` into the Prompts data source, Version = live+1, Input/Output schema
//      columns copied from the prior version, "## Who we are" kept as the shared synced_block
//      (3a84d7b7-884c-81f2-a93f-fe75f6dbc910). Then re-run this with no arg against the live body.
//   4. Inspect versions any time: `sflock prompts list/show --agent reddit-engage`.

import "../../dist/src/env.js";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { getStore } from "../../dist/src/stores/index.js";
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
const candidate = process.argv[2];
const system = candidate ? readFileSync(candidate, "utf8") : live.body;
console.error(`[eval] instructions: ${candidate ?? `live v${live.version} (${live.hash})`}`);

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

const gt = parse(readFileSync("agents/reddit-engage/reddit_qualified_threads.yaml", "utf8"));
const rows = await mapLimit(gt, async (t) => {
	const u = threadUrl(t.url);
	const row = await store.read(config.models.RedditThreads, "Thread URL", u);
	const input = projectInput(row.fields, live.inputSchema);
	const v = await judge(renderEvidence(input));
	return { id: u.match(/comments\/(\w+)/)[1], title: t.title.slice(0, 55), truth: t.tier, got: v.output.tier, claims: v.statements.map((s) => `${s.supporting ? "+" : "-"} ${s.claim}`) };
});

const exact = rows.filter((r) => r.got === r.truth).length;
const gate = rows.filter((r) => (r.got === "No") === (r.truth === "No")).length;
console.log(`\n=== exact ${exact}/${rows.length}, engage-vs-drop ${gate}/${rows.length} ===`);
for (const r of rows) {
	console.log(`${r.got === r.truth ? "  " : "✗ "}${r.id}  truth=${r.truth.padEnd(3)} got=${String(r.got).padEnd(3)} ${r.title}`);
	if (r.got !== r.truth) for (const c of r.claims) console.log(`      ${c}`);
}
