#!/usr/bin/env node
// sflock — the operator CLI: setup (compile contracts → TS types) plus read-only review of an
// agent's Decisions. Both are agent-agnostic — parameterized by --agent — and neither mutates the
// pipeline (that is the per-agent funnel binary's job).
//   sflock pull --agent <id>            an agent's destination models → agents/<id>/schema/<Model>.ts
//   sflock bind --client <name>         a reduck source's manifest     → src/clients/<name>/schema.ts
//   sflock decisions list --agent <id>  the review queue (or --reviewed/--all), each flagged hasFeedback/overturned
//   sflock decisions list --agent <id> --feedback   every decision I have given feedback on, with the feedback
//   sflock decisions show --agent <id> <decision> [--feedback]   one decision, or just its feedback
//   sflock prompts [--check]            re-inline every prompt's shared sections from prompts/*.md
//                                       (--check reports drift instead, and exits 1)
//   sflock eval cases --agent <id>      refresh a prompt's ground_truth.yaml from your reviews
//                                       (additive — hand edits, comments and `skip:` reasons survive)
//   sflock eval judge --agent <id> [candidate.md]   does the SCORER agree with you — the output you
//                                       committed must pass, the draft you overturned must fail
//   sflock eval reply --agent <id> [candidate.md] [--tier T1 --limit n]   does the DRAFTER satisfy
//                                       the scorer — over the reviewed corpus, or any threads at all
//   sflock eval qualify --agent <id> [candidate.md] [--only ids]   does the judgment match your LABEL
//                                       — no scorer (the Output is an enum), no store read (each case
//                                       carries its own evidence): the cheap one, run it on every edit
//   sflock docs list                    the Writer's documents (agent-agnostic — one shared table)
//   sflock docs show <doc>              one document, its body as markdown
//   sflock docs push <doc> [file]       a new version of one document — saved AND applied live in the
//                                       open editor (the one write sflock has; prose, never pipeline state)
//
// pull reads the agent's config.ts (destination + model→table map) and, per model, asks the
// store to `describe` it (a JSON Schema) then compiles that to a TS type — no intermediate
// .json on disk, and the file is named by the model key. bind reads a source's script
// manifest and compiles each script's output schema. decisions reads the shared CRM through
// createReviewer (no entity bridge); docs reads the Writer's table through the Store seam
// (src/docs.ts) — no --agent, because the writing table belongs to no one agent — and pushes through
// the app's own save sink, so a revision reaches the open editor. sflock holds no per-store semantics.
//
// prompts is the ONE command the prompt tree needs, and its smallness is the point: a prompt is a
// folder in git (agents/<id>/prompts/<key>/), so listing, printing and publishing are `ls`, `cat` and
// a commit. What files cannot do for themselves is keep a shared section in step with its source, so
// that — and only that — is a command (src/prompts.ts).
//
// eval is the CALIBRATION half of editing a prompt: a commit changes a judgment's instructions, eval
// says whether it is better. HOW a judgment is graded follows from its Output. Free text needs a
// model, so the scorer is itself a prompt (the agent's `judge` folder), authored and versioned like
// the one it grades; an enum needs nothing but the label you recorded, which is `qualify`. And WHERE
// the corpus lives follows from whether a human reviewed it: a reviewed prompt's ground truth is the
// review history (a query — every review already froze the evidence, the attempt and the human's
// word, so a copy would be a second record of rows the CRM owns), while a calibrated prompt froze
// nothing, so its cases carry their own evidence and the run never reads the store (src/eval.ts).
//
// Review is read-only with ONE exception, and it is a prose exception (README #2): `docs push` hands
// a document back. Prompt text used to be the other, because it lived in a CRM row; it is a file now,
// so editing it is editing a file and `sflock` has nothing to say about it.

import "./env.js";
import { Command } from "commander";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { join } from "node:path";
import { compile } from "json-schema-to-typescript";
import { bind } from "./scripts.js";
import { renderError } from "./errors.js";
import { STORES } from "./stores/index.js";
import { createReviewer } from "./decide.js";
import { pullCases, evalJudge, evalReply, evalQualify } from "./eval.js";
import { syncPrompts } from "./prompts.js";
import * as writer from "./docs.js";
import { renderFeedback } from "./review.js";
import { AGENTS, type Agent } from "../agents/index.js";

// Writable-property count of a described model (a JSON Schema's `properties`) — for the
// progress line. Every store now emits JSON Schema, so there is one shape to read.
const propCount = (described: unknown): number =>
	Object.keys((described as { properties?: object }).properties ?? {}).length;

const program = new Command()
	.name("sflock")
	.description("Operator CLI — compile contracts into TS types, and inspect an agent's Decisions.");

// --agent → its registry entry (config + its own evidence renderer: decisions must display through
// the renderer that judged them). The roster is agents/index.ts — one registration per agent.
const loadAgent = (agent: string): Agent =>
	AGENTS[agent] ?? program.error(`no agent "${agent}" — register it in agents/index.ts.`);

program
	.command("pull")
	.description("Compile each of an agent's models → agents/<agent>/schema/<Model>.ts (TS type)")
	.requiredOption("--agent <id>", "agent under agents/ whose config.ts names the destination + models")
	.action(async ({ agent }: { agent: string }) => {
		const { config } = loadAgent(agent);
		const store = STORES[config.destination];
		const dir = join("agents", agent, "schema");
		await mkdir(dir, { recursive: true });
		for (const [name, model] of Object.entries(config.models)) {
			const described = await store.describe(model);
			const ts = await compile(described as object, name, {
				bannerComment: `// Generated by \`sflock pull --agent ${agent}\` (${config.destination}:${model}). Do not edit — re-pull.`,
				additionalProperties: false
			});
			const path = join(dir, `${name}.ts`);
			await writeFile(path, ts);
			console.error(`${name}: ${propCount(described)} writable properties → ${path}`);
		}
	});

program
	.command("bind")
	.description("Compile a reduck source's script manifest → src/clients/<client>/schema.ts (TS output types)")
	.requiredOption("--client <name>", "source under src/clients/<name>/ with a scripts.ts manifest")
	.action(async ({ client }: { client: string }) => {
		const { scripts } = (await import(`./clients/${client}/scripts.js`)) as { scripts: Record<string, string> };
		const path = join("src", "clients", client, "schema.ts");
		await writeFile(path, await bind(scripts));
		console.error(`${client}: ${Object.keys(scripts).length} scripts → ${path}`);
	});

// decisions — the agent-agnostic review surface, over createReviewer (read-only, no entity bridge).
// JSON on stdout so an agent reads each result; --agent picks whose Decisions table to read.
const decisions = program.command("decisions").description("Inspect an agent's Decisions (read-only).");

decisions
	.command("list")
	.description("List decisions — the pending queue by default — each flagged hasFeedback (any human edit) and overturned (the human changed the committed output).")
	.requiredOption("--agent <id>", "agent under agents/ whose config.ts names the Decisions table")
	.option("--reviewed", "only reviewed decisions (Final output set)")
	.option("--all", "both pending and reviewed")
	.option("--feedback", "only decisions carrying human feedback, each with the feedback itself — spans both states unless you narrow the scope")
	.action(async ({ agent, reviewed, all, feedback }: { agent: string; reviewed?: boolean; all?: boolean; feedback?: boolean }) => {
		const reviewer = createReviewer(loadAgent(agent));
		// Feedback lives in BOTH states — a Save carries a note with no Final output, a commit carries
		// an overturn — so asking for it means "wherever it is", not "in the pending queue". Hence the
		// default widens to `all`; an explicit --reviewed still narrows it.
		const scope = all || (feedback && !reviewed) ? "all" : reviewed ? "reviewed" : "pending";
		console.log(JSON.stringify(await reviewer.list(scope, { feedback }), null, 2));
	});

decisions
	.command("show")
	.argument("<decision>", "Decision id, Notion URL, or app URL")
	.description("One decision (judge's judgment + human diff), or with --feedback just the human feedback snapshot.")
	.requiredOption("--agent <id>", "agent under agents/ whose config.ts names the Decisions table")
	.option("--feedback", "print only the human feedback snapshot (LLM-oriented markdown)")
	.action(async (decision: string, { agent, feedback }: { agent: string; feedback?: boolean }) => {
		const reviewer = createReviewer(loadAgent(agent));
		const shown = await reviewer.showDecision(decision);
		if (feedback) return void console.log(shown.feedback ? renderFeedback(shown.feedback) : "(no human feedback)");
		// Was this judged under the wording that governs today? The Decision pinned its fingerprint;
		// re-fingerprint the files and say so. `stale` means exactly that and nothing more — the prompt
		// has been edited since, benignly or not, and `git log -S` on the prompt folder says by whom and
		// why. Unknown kind / pre-pin row ⇒ omitted.
		const live = shown.kind ? await reviewer.instructionsHash(shown.kind).catch(() => undefined) : undefined;
		const instructions =
			shown.instructions && live
				? { pinned: shown.instructions, live, stale: shown.instructions !== live }
				: { pinned: shown.instructions ?? null, live: live ?? null };
		console.log(JSON.stringify({ ...shown, instructions }, null, 2));
	});

// prompts — the local prompt tree, and the ONE command it needs. A prompt is a FOLDER in git
// (agents/<id>/prompts/<key>/: PROMPT.md, input.json, output.json), so there is nothing to list that
// `ls` doesn't show, nothing to print that `cat` doesn't, and nothing to publish that a commit
// doesn't — `list`, `show`, `edit` and `push` went away with the Notion rows they addressed.
//
// What files cannot do for themselves is stay consistent with each other. A section several prompts
// share is authored once in the pool (prompts/<name>.md) and INLINED into each of them, so the file
// on disk is the whole prompt — and a copy can drift from its source. So: one verb re-inlines every
// copy, one flag checks them instead, out of one function (src/prompts.ts). Same shape as
// sync-agent-skills.py + check.py in anthropics/financial-services, minus the second script — and
// src/prompts.test.ts asserts the check is empty, so drift is also red on `npm test`.
program
	.command("prompts")
	.description("Re-inline every prompt's shared sections from the pool (prompts/*.md). Agent-agnostic — it walks the tree.")
	.option("--check", "report drift instead of fixing it, and exit 1 if any inlined section differs from its source")
	.action(async ({ check }: { check?: boolean }) => {
		const states = await syncPrompts({ apply: !check });
		for (const s of states)
			console.log(
				`${s.drifted.length ? (check ? "✗ " : "→ ") : "  "}${`${s.agent}/${s.key}`.padEnd(28)} ${s.hash}  ` +
					`${s.regions.length ? s.regions.join(", ") : "(no shared sections)"}` +
					`${s.drifted.length ? `  ${check ? "DRIFTED" : "re-inlined"}: ${s.drifted.join(", ")}` : ""}`
			);
		const drifted = states.filter((s) => s.drifted.length);
		if (check && drifted.length) {
			console.error(
				`\n${drifted.length} prompt(s) carry a section that no longer matches its source. The pool file ` +
					`IS the source — edit prompts/<name>.md, then run \`sflock prompts\` to re-inline it everywhere.`
			);
			process.exit(1);
		}
	});

// docs — the Writer's long-form documents (the /write surface of the review app). No --agent: it is
// ONE shared writing table (NOTION_WRITER_DS), not an agent's model. `list` indexes them, `show` prints
// one with its body as markdown — the document itself, since prose lives in the page body — and `push`
// hands one back, live. Authoring stays in the app's editor (or Notion's); this is the loop between them.
const docs = program.command("docs").description("Read the Writer's documents, and push a revision into the open editor.");

docs
	.command("list")
	.description("Every document in the Writer's table — id, url, and its properties (Name, Status, …). Bodies are `show`'s job.")
	.action(async () => console.log(JSON.stringify(await writer.list(), null, 2)));

docs
	.command("show")
	.argument("<doc>", "document id, Notion URL, or app URL (/write/<id>)")
	.description("One document: its properties plus `markdown` — the page body, which IS the document.")
	.action(async (doc: string) => console.log(JSON.stringify(await writer.show(doc), null, 2)));

// push — the write, and the only one `sflock` has: a revision of a document, handed to the app's own
// save sink so it lands on the Notion page AND in the editor that has it open (no reload). Prose to a
// document; pipeline state stays the runtime binaries'. Markdown comes from a file or stdin, because a
// revision is text — not an argument.
docs
	.command("push")
	.argument("<doc>", "document id, Notion URL, or app URL (/write/<id>)")
	.argument("[file]", `markdown file; omit (or "-") to read the document from stdin`)
	.option("--title <title>", "also retitle the document (omit to leave its Name alone)")
	.description("Push a new version of a document: saved to Notion and applied live in the open editor (one undo step). Needs the local app running.")
	.action(async (doc: string, file: string | undefined, { title }: { title?: string }) => {
		const markdown = file && file !== "-" ? await readFile(file, "utf8") : await text(process.stdin);
		console.log(JSON.stringify(await writer.push(doc, { markdown, title }), null, 2));
	});

// eval — the calibration half of editing a prompt file: a commit writes the next version of a
// judgment's instructions, this says whether it is better. Read-only, agent-agnostic, and asked in
// a fixed order — first whether the SCORER agrees with you, then whether the DRAFTER satisfies the
// scorer. Grading free text needs a model, so the scorer is itself a Prompt (the agent's `judge`
// spec), improved through the very same three verbs as the prompt it grades.
//
// The corpus is a QUERY, not a file (src/eval.ts): every review already froze the whole example, so
// a ground-truth file would be a second copy of rows the CRM owns. `cases` prints it — redirect it
// for a snapshot. Report goes to stdout because for an eval the report IS the answer.
const evaluate = program
	.command("eval")
	.description("Calibrate an agent's prompts: does the judge agree with you, does the drafter satisfy the judge.");

evaluate
	.command("cases")
	.description("Refresh the ground-truth YAML beside the agent from your reviews. ADDITIVE: an entry already in the file is left untouched — your edits, your comments and your `skip:` reasons all survive, which is why this is a file and not a query. Only unseen decisions are appended.")
	.requiredOption("--agent <id>", "agent under agents/ whose Decisions carry the reviews")
	.option("--prompt <key>", "the graded prompt's key in config.prompts", "reply")
	.action(async ({ agent, prompt }: { agent: string; prompt: string }) => {
		const { path, added, kept, total } = await pullCases(agent, prompt);
		console.log(`${path}: ${added} added, ${kept} kept, ${total} total`);
	});

evaluate
	.command("judge")
	.argument("[candidate]", `a copy of the judge's PROMPT.md; omit to score the committed one`)
	.description("Does the SCORER agree with you? Each reviewed decision is one or two assertions: the output you committed MUST pass, the draft you overturned MUST fail. Nothing is re-generated — these are the texts you actually ruled on.")
	.requiredOption("--agent <id>", "agent under agents/ whose config.ts declares a `judge` prompt")
	.option("--prompt <key>", "the graded prompt's key in config.prompts", "reply")
	.action(async (candidate: string | undefined, { agent, prompt }: { agent: string; prompt: string }) => {
		const { label, positives, negatives, errored, rows } = await evalJudge(agent, prompt, candidate);
		const ok = (g: { valid: boolean; expect: boolean }) => g.valid === g.expect;
		const tally = (g: { valid: boolean; expect: boolean }[]) => `${g.filter(ok).length}/${g.length}`;
		console.log(`\n=== judge ${label} — agrees ${tally([...positives, ...negatives])}${errored ? `, ${errored} unscoreable` : ""}`);
		console.log(`    committed  ${tally(positives)}  (must pass)`);
		console.log(`    overturned ${tally(negatives)}  (must fail)`);
		for (const r of rows)
			for (const g of r.got) {
				// An unscoreable case is neither agreement nor disagreement — flagged apart, never tallied.
				if (!("valid" in g)) {
					console.log(`! ${g.text.padEnd(10)} ${"—".padEnd(7)}  ${r.c.name}\n      ${g.error}`);
					continue;
				}
				console.log(`${ok(g) ? "  " : "✗ "}${g.text.padEnd(10)} ${g.valid ? "valid  " : "invalid"}  ${r.c.name}`);
				if (!ok(g)) for (const w of g.why) console.log(`      ${w}`);
			}
	});

evaluate
	.command("reply")
	.argument("[candidate]", `a copy of the prompt's PROMPT.md; omit to score the committed one`)
	.description("Does the DRAFTER satisfy the judge? Re-drafts each thread under the candidate instructions and rules on the result. With no filters it uses the reviewed corpus (frozen evidence, so runs compare); --tier/--limit grade any threads at all — that is what having a judge buys.")
	.requiredOption("--agent <id>", "agent under agents/ whose prompt is being graded")
	.option("--prompt <key>", "the graded prompt's key in config.prompts", "reply")
	.option("--tier <tier>", "grade stored threads at this tier instead of the reviewed corpus")
	.option("--subreddit <names...>", "narrow those threads to these subreddits")
	.option("--limit <n>", "keep only the newest <n>")
	.action(async (candidate: string | undefined, f: { agent: string; prompt: string; tier?: string; subreddit?: string[]; limit?: string }) => {
		const select = f.tier || f.subreddit || f.limit ? { tier: f.tier, subreddit: f.subreddit, limit: f.limit ? Number(f.limit) : undefined } : undefined;
		const { label, judge, rows } = await evalReply(f.agent, f.prompt, candidate, select);
		const scored = rows.filter((r) => "valid" in r);
		const bad = rows.length - scored.length;
		console.log(`\n=== ${f.prompt} ${label}, judged by ${judge} — valid ${scored.filter((r) => r.valid).length}/${scored.length}${bad ? `, ${bad} unscoreable` : ""}`);
		for (const r of rows) {
			if (!("valid" in r)) {
				console.log(`! ${r.name}\n      ${r.error}`);
				continue;
			}
			console.log(`${r.valid ? "  " : "✗ "}${r.name}`);
			if (!r.valid) {
				for (const w of r.why) console.log(`      ${w}`);
				console.log(`      drafted: ${JSON.stringify(r.drafted).slice(0, 160)}`);
				if (r.mine) console.log(`      yours:   ${JSON.stringify(r.mine).slice(0, 160)}`);
			}
		}
	});

// qualify — the third question, and the only one with no model in the scoring loop: does the
// judgment produce the LABEL you recorded? For a prompt whose Output is an enum the ground truth IS
// the answer, so there is nothing for a scorer to rule on. Its corpus is a self-contained file
// (each case carries its own evidence), so this runs offline and reproducibly — cheap enough for
// every edit, which is what a filter that nobody reviews needs.
evaluate
	.command("qualify")
	.argument("[candidate]", `a copy of the prompt's PROMPT.md; omit to score the committed one`)
	.description("Does the judgment match your label? Each case in the ground truth carries its own evidence and the Output you recorded — no scorer, no store read. Reports exact agreement, agreement on the GATE (does it advance, per the prompt's own `resolve`), and pre-screen kills.")
	.requiredOption("--agent <id>", "agent under agents/ whose prompt is being graded")
	.option("--prompt <key>", "the graded prompt's key in config.prompts", "qualify")
	.option("--only <ids...>", "grade only the cases whose key contains one of these — tune one case without paying for the set")
	.action(async (candidate: string | undefined, f: { agent: string; prompt: string; only?: string[] }) => {
		const { label, path, skipped, rows } = await evalQualify(f.agent, f.prompt, candidate, f.only);
		const scored = rows.filter((r) => !("error" in r) || !r.error);
		const tally = (p: (r: (typeof rows)[number]) => boolean) => rows.filter(p).length;
		if (skipped) console.error(`${skipped} case(s) skipped by the ground truth`);
		console.error(`[eval] ${f.prompt} ${label} — ${path}`);
		for (const r of rows) {
			if ("error" in r && r.error) {
				console.log(`! ${r.f.key}\n      ${r.error}`);
				continue;
			}
			// ☠ before ✗: a pre-screen kill is the worse failure, because in production the read this
			// row was scored on would never have happened at all.
			const flag = r.killed ? "☠ " : r.exact ? "  " : "✗ ";
			const id = r.f.key.match(/comments\/(\w+)/)?.[1] ?? r.f.key;
			const phase = r.twoPhase ? `pre=${JSON.stringify(r.pre).slice(0, 18).padEnd(18)}` : " ".repeat(18);
			console.log(
				`${flag}${id}  want=${JSON.stringify(r.f.expect).padEnd(16)} ${phase} got=${JSON.stringify(r.got).padEnd(16)} ${r.f.note?.split("\n")[0].slice(0, 50) ?? ""}`
			);
			if (!r.exact) for (const c of r.claims ?? []) console.log(`      ${c}`);
		}
		const unscored = rows.length - scored.length;
		console.log(
			`\n=== ${f.prompt}: exact ${tally((r) => !!r.exact)}/${rows.length}, gate ${tally((r) => r.gate !== false)}/${rows.length}, pre-screen kills ${tally((r) => !!r.killed)}${unscored ? `, ${unscored} unscoreable` : ""} ===`
		);
	});

program.parseAsync().catch((e: unknown) => {
	console.error(renderError(e));
	process.exit(1);
});
