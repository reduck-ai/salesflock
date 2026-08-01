#!/usr/bin/env node
// Offline eval of "Reddit Thread Qualification" against EVERY ./*_qualified_threads.yaml (the
// human-labeled ground truths — one file per subreddit digest; a candidate must win them ALL, or
// it just overfits the newest set). FAITHFUL to the runtime, and not by resemblance: evidence comes
// from the frozen Notion rows (projectInput → renderEvidence) and the judging is `runJudgment`
// ITSELF, the same call `rdt engage` makes — only the instruction body is swappable. (This file
// used to carry its own copy of that two-tool loop, which meant it could certify a prompt against
// code that was not the code that runs.)
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
//   0. BASELINE first — run with no arg, before changing anything. Without it a red row is ambiguous
//      ("did I break this, or was it already red?"), and a green run on a ground truth you just
//      relabelled proves nothing about the prompt. Measured: relabelling four threads and re-running
//      showed exactly those four failing, which is what confirmed the old body really did score them
//      the old way rather than the labels being noise.
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
import { parse, stringify } from "yaml";
import { getStore } from "../../dist/src/stores/index.js";
import { compileAuthoring } from "../../dist/src/stores/notion.codec.js";
import { createReviewer, runJudgment } from "../../dist/src/decide.js";
import { renderEvidence, fieldSpan } from "../../dist/agents/reddit-engage/evidence.js";
import { projectInput } from "../../dist/src/project.js";
import { threadUrl } from "../../dist/src/clients/reddit/index.js";
import { mapLimit } from "../../dist/src/concurrency.js";
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

// The runtime's own loop, called with the candidate instructions in place of the live body. No
// `examples` — none exist for this kind (verified), and the runtime would pass the same nothing.
const judge = (evidence) => runJudgment({ system, evidence, outputSchema: live.outputSchema }, config.model);

// The PRE-SCREEN check, and the reason it exists: `engage` reads a thread twice on growing evidence
// — the post alone, then (only if that survives) the whole page with its comments. The second read
// is the one this eval scores, but the first one holds a veto nothing else can catch: a thread it
// drops is never fetched, so the definitive read never happens and the miss leaves no trace. That
// is eliminating on ABSENCE of evidence, frozen by a monotonic ladder — the exact failure the
// funnel's invariants forbid.
//
// So each hydrated case is judged a second time on its seed with `comments` REMOVED, reproducing
// what the pre-screen saw. The verdict may legitimately differ (that is the point of fetching);
// what may never happen is a pre-screen "No" on a thread the truth says to engage. A case with no
// stored comments has nothing to strip — its two reads are the same read, so it costs no extra call.
const stripComments = (input) => {
	const seed = parse(input.Thread ?? "");
	if (!seed || !Array.isArray(seed.comments)) return null;
	delete seed.comments;
	return { ...input, Thread: stringify(seed, { lineWidth: 0 }) };
};

const DIR = "agents/reddit-engage";
const files = readdirSync(DIR).filter((f) => f.endsWith("_qualified_threads.yaml"));
let allExact = 0;
let allGate = 0;
let allFatal = 0;
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
		const opOnly = stripComments(input);
		// No comments stored ⇒ the pre-screen IS this read; don't pay for it twice.
		const pre = opOnly ? (await judge(renderEvidence(opOnly))).output.tier : v.output.tier;
		return {
			id: u.match(/comments\/(\w+)/)[1],
			title: t.title.slice(0, 55),
			truth: t.tier,
			got: v.output.tier,
			pre,
			twoPhase: !!opOnly,
			claims: v.statements.map((s) => `${s.supporting ? "+" : "-"} ${s.claim}`)
		};
	});
	const exact = rows.filter((r) => r.got === r.truth).length;
	const gate = rows.filter((r) => (r.got === "No") === (r.truth === "No")).length;
	// A pre-screen drop on a thread the truth says to engage: the thread is never fetched, so the
	// verdict scored above would never have been reached in production. Louder than a wrong tier.
	const fatal = rows.filter((r) => r.pre === "No" && r.truth !== "No");
	allExact += exact;
	allGate += gate;
	allFatal += fatal.length;
	total += rows.length;
	console.log(`\n=== ${file}: exact ${exact}/${rows.length}, engage-vs-drop ${gate}/${rows.length}, pre-screen kills ${fatal.length} ===`);
	for (const r of rows) {
		const flag = r.pre === "No" && r.truth !== "No" ? "☠ " : r.got === r.truth ? "  " : "✗ ";
		const phase = r.twoPhase ? `pre=${String(r.pre).padEnd(3)}` : "          ";
		console.log(`${flag}${r.id}  truth=${r.truth.padEnd(3)} ${phase} got=${String(r.got).padEnd(3)} ${r.title}`);
		if (r.got !== r.truth) for (const c of r.claims) console.log(`      ${c}`);
	}
}
console.log(`\n=== TOTAL: exact ${allExact}/${total}, engage-vs-drop ${allGate}/${total}, pre-screen kills ${allFatal} ===`);
if (allFatal) console.log(`☠ = the post-only read drops a thread the truth engages — it would never reach the second read.`);
