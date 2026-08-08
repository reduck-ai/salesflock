#!/usr/bin/env node
// sflock — the operator CLI: setup (compile contracts → TS types) plus read-only review of an
// agent's Decisions. Both are agent-agnostic — parameterized by --agent — and neither mutates the
// pipeline (that is the per-agent funnel binary's job).
//   sflock pull --agent <id>            an agent's destination models → agents/<id>/schema/<Model>.{json,ts}
//   sflock init --parent <page>         the inverse: those schemas → real tables in YOUR workspace,
//                                       their ids written to models.local.json. All of onboarding.
//   sflock bind --client <name>         a reduck source's manifest     → src/clients/<name>/schema.ts
//   sflock decisions list --agent <id>  the review queue (or --reviewed/--all), each flagged hasFeedback/overturned
//   sflock decisions list --agent <id> --feedback   the WORKLIST: every decision carrying a note,
//                                       with the note — `learn` clears them, so this list drains
//   sflock decisions show --agent <id> <decision> [--feedback]   one decision, or just its feedback
//   sflock prompts [--check]            re-inline every prompt's shared sections from prompts/*.md
//                                       (--check reports drift instead, and exits 1)
//   sflock learn <decision> --agent <id> [--prompt <key>] [--expect <json>]   a decision becomes a
//                                       ground-truth CASE: your note is the rule, the frozen evidence
//                                       the fixture, and the row stops asking
//   sflock eval --agent <id> --prompt <key> [candidate.md] [--only ids]   score a prompt against that
//                                       corpus — one verb, the grading derived from the Output
//   sflock docs list                    the Writer's documents (agent-agnostic — one shared table)
//   sflock docs show <doc>              one document, its body as markdown
//   sflock docs push <doc> [file]       a new version of one document — saved AND applied live in the
//                                       open editor (the one write sflock has; prose, never pipeline state)
//
// pull and init are INVERSES over one committed artifact — agents/<id>/schema/<Model>.json. pull
// reads the agent's config.ts (destination + the model names it addresses) and, per model, asks the
// store to `describe` it: a JSON Schema, written to disk, and the TS type compiled from that same
// file. init reads those files back and builds the tables they declare in a workspace that has none,
// which is the whole of what a fork has to do. What makes the round trip possible is that a schema
// names its relations by MODEL KEY rather than by a uuid that means something in one workspace only;
// the ids themselves are never committed (src/models.ts). bind reads a source's script manifest and
// compiles each script's output schema. decisions reads the shared CRM through
// createReviewer (no entity bridge); docs reads the Writer's table through the Store seam
// (src/docs.ts) — no --agent, because the writing table belongs to no one agent — and pushes through
// the app's own save sink, so a revision reaches the open editor. sflock holds no per-store semantics.
//
// prompts is the ONE command the prompt tree needs, and its smallness is the point: a prompt is a
// folder in git (agents/<id>/prompts/<key>/), so listing, printing and publishing are `ls`, `cat` and
// a commit. What files cannot do for themselves is keep a shared section in step with its source, so
// that — and only that — is a command (src/prompts.ts).
//
// learn and eval are INVERSES, and together they are the whole calibration loop: `learn` turns a
// Decision into a case, `eval` turns cases into a score. One writes the corpus, one reads it, and
// nothing else touches it. A corpus is SELF-CONTAINED — every case carries the evidence it was
// labelled on — which is what lets `learn` retire the row it came from and `eval` run offline.
//
// HOW a prompt is graded follows from its Output, and that is now derived rather than named: a
// checkable Output (an enum, a boolean) is compared to your label, prose is ruled on by the agent's
// scorer, and which is which comes from one declaration — the scorer says what it `grades`
// (config.ts). Hence one `eval` verb where there were three (src/eval.ts).
//
// Review is read-only with TWO exceptions, and both write PROSE, never pipeline state (README #2):
// `docs push` hands a document back, and `learn` moves a note out of the CRM and into git. Prompt
// text used to be a third, because it lived in a CRM row; it is a file now, so editing it is editing
// a file and `sflock` has nothing to say about it.

import "./env.js";
import { Command } from "commander";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { join } from "node:path";
import { compile } from "json-schema-to-typescript";
import { bind } from "./scripts.js";
import { devices } from "./clients/reduck.js";
import { renderError } from "./errors.js";
import { STORES } from "./stores/index.js";
import { createReviewer } from "./decide.js";
import { learn, evaluate } from "./eval.js";
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
	.description("Compile each of an agent's models → agents/<agent>/schema/<Model>.json (the contract) + .ts (the type)")
	.requiredOption("--agent <id>", "agent under agents/ whose config.ts names the destination + models")
	.action(async ({ agent }: { agent: string }) => {
		const { config } = loadAgent(agent);
		const store = STORES[config.destination];
		const dir = join("agents", agent, "schema");
		await mkdir(dir, { recursive: true });
		for (const [name, model] of Object.entries(config.models)) {
			// `config.models` rides in so a relation names the MODEL KEY it points at rather than a uuid.
			// That one substitution is what makes the file below portable — and therefore what makes
			// `sflock init` possible at all.
			const described = await store.describe(model, config.models);
			// The id of the table it was read FROM is not part of its contract: ids belong to an
			// installation (models.local.json), the schema belongs to the repo.
			const { $id: _id, ...schema } = described as { $id?: string };
			await writeFile(join(dir, `${name}.json`), `${JSON.stringify(schema, null, 2)}\n`);
			const ts = await compile(schema as object, name, {
				bannerComment: `// Generated by \`sflock pull --agent ${agent}\` from ${name}.json. Do not edit — re-pull.`,
				additionalProperties: false
			});
			await writeFile(join(dir, `${name}.ts`), ts);
			console.error(`${name}: ${propCount(described)} writable properties → ${join(dir, `${name}.{json,ts}`)}`);
		}
	});

// init — the inverse of `pull`, and the whole of onboarding: the tables an agent's committed schemas
// declare, built under one Notion page in YOUR workspace. `pull` reads a table into a contract; this
// reads that contract back into a table, so the two are inverses over one artifact
// (agents/<id>/schema/<Model>.json) exactly as `learn` and `eval` are over a corpus.
//
// EVERY AGENT BY DEFAULT, because a fork setting up wants a system, not a table — and because the
// Decisions table is SHARED, so provisioning agents one at a time would either fight over it or
// leave a relation pointing at something that does not exist yet. The schemas are merged and deduped
// by table title before a single call, and `provision` does the rest in one pass.
//
// The ids it creates are written to models.local.json, which is the only place they live: config.ts
// declares model NAMES, never ids (src/models.ts).
const readSchema = async (agent: string, name: string): Promise<object> =>
	JSON.parse(await readFile(join("agents", agent, "schema", `${name}.json`), "utf8").catch(() => {
		throw new Error(
			`no agents/${agent}/schema/${name}.json — the contract for "${name}" is missing. ` +
				`Run \`sflock pull --agent ${agent}\` against a workspace that already has it.`
		);
	})) as object;

program
	.command("init")
	.description("Create the tables an agent's schemas declare, under a Notion page you own — then write their ids to models.local.json. The inverse of `pull`, and the whole of setting up a fork.")
	.requiredOption("--parent <url>", "the Notion page to create them under (share it with your integration first)")
	.option("--agent <ids...>", "only these agents (default: every one in the roster — relations cross agents, so narrowing can fail loud)")
	.option("--force", "adopt tables that already exist under that page and add the properties they lack. Only ever adds — never deletes a property, a row or a table.")
	.action(async ({ parent, agent, force }: { parent: string; agent?: string[]; force?: boolean }) => {
		const ids = agent?.length ? agent : Object.keys(AGENTS);
		for (const id of ids) loadAgent(id); // an unknown --agent fails here, before anything is created
		// One store, because one parent page: a table's destination is the agent's `destination`, and
		// two agents pointing at different backends could not share a page anyway.
		const destinations = [...new Set(ids.map((a) => AGENTS[a].config.destination))];
		if (destinations.length > 1)
			program.error(`these agents write to different destinations (${destinations.join(", ")}) — run init per destination with --agent`);
		const store = STORES[destinations[0]];

		// Merged across agents and deduped by MODEL NAME: `Decisions` is one shared table that several
		// agents address, and building it twice is exactly the fork this whole seam exists to prevent.
		// Which agents wanted each one is kept, so the write-back can give every one of them its id.
		const schemas: Record<string, object> = {};
		const wantedBy: Record<string, string[]> = {};
		for (const id of ids)
			for (const name of Object.keys(AGENTS[id].config.models)) {
				schemas[name] ??= await readSchema(id, name);
				(wantedBy[name] ??= []).push(id);
			}

		const refs = await store.provision(schemas, parent, { force });

		// models.local.json — merged into whatever is already there, so setting up a second agent later
		// cannot wipe the first one's ids.
		const path = "models.local.json";
		const current = JSON.parse(await readFile(path, "utf8").catch(() => "{}")) as Record<string, Record<string, string>>;
		for (const [name, ref] of Object.entries(refs))
			for (const id of wantedBy[name]) (current[id] ??= {})[name] = ref.id;
		await writeFile(path, `${JSON.stringify(current, null, 2)}\n`);

		for (const [name, ref] of Object.entries(refs))
			console.error(`${name.padEnd(16)} ${ref.created ? "created" : "adopted"}  ${ref.url}`);
		console.error(`\n→ ${path} — the ids this installation reads. Git-ignored; for a deployment, set\n  SALESFLOCK_MODELS to its contents.`);
		console.log(JSON.stringify(refs, null, 2));
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

// devices — the paired browsers, by id. Not a contract to compile and not an agent's business: it is
// the one fact an operator needs before writing `DEVICES` into an agent's config, and it is
// unanswerable from in here otherwise (the REST run door has no devices endpoint, so the client asks
// the MCP door). Prints the server's own text — WHICH account each browser is signed into is a
// separate question, and only `reduck run --script reduck/reddit.com/whoami --device <id>` answers it.
program
	.command("devices")
	.description("List the paired browsers (id, kind, online) — the ids an agent's config pins.")
	.action(async () => console.log(await devices()));

// decisions — the agent-agnostic review surface, over createReviewer (read-only, no entity bridge).
// JSON on stdout so an agent reads each result; --agent picks whose Decisions table to read.
const decisions = program.command("decisions").description("Inspect an agent's Decisions (read-only).");

decisions
	.command("list")
	.description("List decisions — the pending queue by default — each flagged hasFeedback (any human edit) and overturned (the human changed the committed output).")
	.requiredOption("--agent <id>", "agent under agents/ whose config.ts names the Decisions table")
	.option("--reviewed", "only reviewed decisions (Final output set)")
	.option("--all", "both pending and reviewed")
	.option("--feedback", "only decisions carrying a NOTE — the worklist, because a note is a TODO and `sflock learn` clears it. Spans both states unless you narrow the scope.")
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

// learn — a Decision becomes a CASE, and the two verbs below are inverses: this writes the corpus,
// `eval` reads it. It is the one write `sflock` has beside `docs push`, and it is a write to GIT —
// the row it reads is only ever retired.
//
// The loop it closes: I see a bad draft in the review app and leave a note. That note is a TODO —
// "this regressed, do something". `learn` is the something: the note becomes the `note` of a
// ground-truth case, carrying the evidence it was ruled on, and the Decision stops asking. So a
// complaint is recorded exactly once, in the place that can hold a machine to it.
//
// --prompt is the one thing a human must supply and a machine cannot infer: WHICH judgment this
// teaches. It defaults to the decision's own kind — but the sharpest case is the other one, because
// a note left on a REPLY ("this thread is off topic", "he's a student") is a complaint about
// QUALIFY, and until now the only way to handle it was to drop the case with a `skip:`. Now it is
// routed: `projectInput` reduces the frozen evidence to exactly the fields that judgment sees.
program
	.command("learn")
	.argument("<decision>", "Decision id, Notion URL, or app URL")
	.description("Turn a decision into a ground-truth case: your note becomes the rule, the frozen evidence becomes the fixture, and the row stops asking. An APPROVED decision stays (it is history — only the note moves); one you never approved is archived and its entity dropped.")
	.requiredOption("--agent <id>", "agent under agents/ whose Decisions table holds it")
	.option("--prompt <key>", "which judgment this teaches (default: the decision's own kind) — use it to route a qualification complaint left on a reply")
	.option("--expect <json>", `the Output that SHOULD have come out, e.g. '{"tier":"No"}' — required when --prompt is not the decision's own kind`)
	.action(async (decision: string, f: { agent: string; prompt?: string; expect?: string }) => {
		const expect = f.expect ? (JSON.parse(f.expect) as Record<string, unknown>) : undefined;
		console.log(JSON.stringify(await learn(f.agent, decision, { prompt: f.prompt, expect }), null, 2));
	});

// eval — the calibration half of editing a prompt file: a commit writes the next version of a
// judgment's instructions, this says whether it is better. ONE verb, because every eval is one
// sentence — run a prompt over its cases, reduce each output to a verdict, compare the verdict to
// what was expected — and only the REDUCTION varies. Which reduction applies is DERIVED from one
// declaration, the scorer's `grades` (config.ts):
//
//   --prompt qualify   nothing grades it   → the Output is the verdict: `===`, no model, offline
//   --prompt reply     `judge` grades it   → draft it, then the scorer rules on the draft
//   --prompt judge     it grades `reply`   → its cases are DERIVED from reply's corpus, each read
//                                            twice: `expect` must be ruled valid, `reject` invalid
//
// Read-only. The report goes to stdout because for an eval the report IS the answer.
program
	.command("eval")
	.argument("[candidate]", "a copy of the prompt's PROMPT.md; omit to score the committed one")
	.description("Score a prompt against its ground truth. How it is graded follows from the Output — a checkable one is compared to your label, prose is ruled on by the agent's scorer — so there is one command for all three questions.")
	.requiredOption("--agent <id>", "agent under agents/ whose prompt is being graded")
	.requiredOption("--prompt <key>", "the prompt's key in config.prompts")
	.option("--only <ids...>", "grade only the cases whose key contains one of these — tune one case without paying for the set")
	.option("--tier <tier>", "grade live subjects at this tier instead of the corpus (scorer-graded prompts only — that is what having a judge buys)")
	.option("--subreddit <names...>", "narrow those live subjects")
	.option("--limit <n>", "keep only the newest <n> of them")
	.action(async (candidate: string | undefined, f: { agent: string; prompt: string; only?: string[]; tier?: string; subreddit?: string[]; limit?: string }) => {
		const { label, path, mode, skipped, rows } = await evaluate(f.agent, f.prompt, candidate, {
			only: f.only,
			tier: f.tier,
			subreddit: f.subreddit,
			limit: f.limit ? Number(f.limit) : undefined
		});
		if (skipped) console.error(`${skipped} case(s) skipped by the ground truth`);
		console.error(`[eval] ${f.prompt} ${label} — ${mode} — ${path}`);
		for (const r of rows) {
			if (r.error) {
				console.log(`! ${r.name}\n      ${r.error}`);
				continue;
			}
			// ☠ before ✗: a pre-screen kill is the worse failure, because in production the read this
			// case was scored on would never have happened at all.
			const flag = r.killed ? "☠ " : r.ok ? "  " : "✗ ";
			const brief = (v: unknown) => (v === undefined ? "" : JSON.stringify(v).slice(0, 60));
			console.log(
				`${flag}${r.name.replace(/^https:\/\/www\.reddit\.com/, "")}  ` +
					`want=${brief(r.expect).padEnd(16)} ${r.pre !== undefined ? `pre=${brief(r.pre).padEnd(14)}` : ""} ` +
					`got=${brief(r.got).padEnd(16)} ${r.note?.split("\n")[0].slice(0, 48) ?? ""}`
			);
			if (!r.ok) for (const w of r.why) console.log(`      ${w}`);
		}
		const scored = rows.filter((r) => !r.error);
		const n = (p: (r: (typeof rows)[number]) => unknown) => rows.filter(p).length;
		console.log(
			`\n=== ${f.prompt}: ${n((r) => r.ok)}/${rows.length} agree` +
				(rows.some((r) => r.gate !== undefined) ? `, gate ${n((r) => r.gate !== false)}/${rows.length}` : "") +
				(rows.some((r) => r.killed) ? `, pre-screen kills ${n((r) => r.killed)}` : "") +
				(rows.length - scored.length ? `, ${rows.length - scored.length} unscoreable` : "") +
				" ==="
		);
	});

program.parseAsync().catch((e: unknown) => {
	console.error(renderError(e));
	process.exit(1);
});
