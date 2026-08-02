// The calibration surface — agent-agnostic, read-only, and the counterpart of `sflock prompts
// edit/push`: authoring writes the next version of a judgment's instructions, this says whether it
// is any better. Two evals, because there are two questions and they must be asked in this order:
//
//   evalJudge  — does the SCORER agree with the human?   (its ground truth is the review history)
//   evalReply  — does the DRAFTER satisfy the scorer?    (needs no labels, so it runs anywhere)
//
// Free text cannot be scored by `===`, so the scorer is a Prompt row like everything else (the
// agent's `judge` spec): versioned, fingerprinted, and authored through the same three verbs as the
// prompt it grades. A hand-written checker would drift from the instructions it checks; a Prompt
// cannot, because a run reports which version scored it.
//
// THE CORPUS IS A QUERY, NOT A FILE. Every review already freezes the whole example — the evidence
// (`Input`), the model's attempt (`Output`) and the human's word (`Final output`) — so a ground-truth
// file would be a second copy of rows the CRM owns, out of date the moment anyone reviews again.
// `cases()` derives it instead, and `sflock eval cases` prints it for eyeballing (redirect it for a
// snapshot). That holds because a review FROZE the evidence; a calibrated prompt freezes nothing, so
// its corpus obeys the opposite rule — see `evalQualify` at the bottom of this file.
//
// An overturn yields a PAIR on one decision — the committed text is a positive, the draft it
// replaced a negative — same evidence, opposite verdict, which is the sharpest thing a binary judge
// can be held to. A decision confirmed verbatim yields one positive that is MODEL-written, and that
// class matters: a corpus whose positives are all human-written calibrates a style detector, not a
// rule checker.
//
// FAITHFUL BY CONSTRUCTION, twice over. The re-judge goes through the agent's own decider
// (`judgmentContext`), swapping only the instructions — so subject resolution, the Input projection,
// the evidence render and the few-shot block are the runtime's, not a copy. And a case is re-judged
// against its FROZEN Input rather than a fresh read of the row: the human labelled THAT evidence,
// and the thread has moved on since (more comments, a different score). Scoring against today's
// thread would grade the candidate on evidence nobody ever ruled on.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isSeq, parse, parseDocument, stringify } from "yaml";
import { AGENTS, type Agent } from "../agents/index.js";
import { createReviewer, runJudgment, type Contract, type Subject } from "./decide.js";
import { compileAuthoring } from "./stores/notion.codec.js";
import { feedbackOf } from "./review.js";
import { projectInput } from "./project.js";
import { getStore, queryAll, type PromptSpec, type Store } from "./stores/index.js";
import { mapLimit } from "./concurrency.js";
import { schemaError } from "./output.js";
import { renderError } from "./errors.js";

// A labelled example, derived from one reviewed Decision. `good` is what the human committed (they
// would post it: the judge must pass it); `bad` is the draft they replaced, present only on an
// overturn (the judge must fail it). Both are whole Output objects, not one field, because that is
// what the judge's Input takes — the reply's Output spliced onto the reply's Input.
export interface Case {
	id: string;
	name: string;
	input: Record<string, string>; // the FROZEN evidence map the human ruled on
	good: Record<string, unknown>;
	bad?: Record<string, unknown>;
	note?: string; // the human's own stated criterion, when they left one
}

// The agent's funnel module — the ONE thing core cannot derive: how to resolve a subject into
// judgeable evidence, and how to name a set of them. Structural, not a registration: it is reached
// by dynamic import on the one path that needs it, so the roster stays static-import-only and the
// review app's bundle never pulls in tools.ts (which imports the reduck runner and the store).
interface AgentFunnel {
	decider: {
		judgmentContext: (
			key: string,
			handle: string | Subject
		) => Promise<{
			system: string;
			examples?: string;
			evidence: string;
			input: Record<string, string>;
			outputSchema: Record<string, unknown>;
		}>;
	};
	tools: { threads: { get: (select: object) => Promise<{ url: string; title: unknown }[]> } };
}

// The agent + the pieces every eval needs from it, resolved once.
interface Ctx {
	agent: Agent;
	store: Store;
	reviewer: ReturnType<typeof createReviewer>;
	kind: string; // the graded prompt's Prompt Name
	spec: PromptSpec; // the graded prompt's semantics — `resolve` is what "this outcome advances" means
}

const load = async (id: string, prompt: string): Promise<Ctx> => {
	const agent = AGENTS[id];
	if (!agent) throw new Error(`no agent "${id}" — register it in agents/index.ts.`);
	const { config } = agent;
	const spec = config.prompts?.[prompt];
	if (!spec) throw new Error(`agent "${id}" declares no prompt "${prompt}"`);
	return {
		agent,
		store: getStore(config.destination),
		reviewer: createReviewer(agent),
		kind: spec.name,
		spec
	};
};

// The SCORER's live contract, resolved only by the evals that need a model to grade. `evalQualify`
// does not: its Output is an enum, so the ground truth IS the answer and `===` settles it. Demanding
// a `judge` prompt there would make a calibrated stage declare a scorer it never runs.
const scorerOf = async ({ agent, reviewer }: Ctx): Promise<Contract> => {
	const judge = agent.config.prompts?.judge;
	if (!judge) throw new Error(`this agent declares no "judge" prompt to score with`);
	return reviewer.showPrompt(judge.name);
};

// The instructions under test: a candidate file, or the live body. A candidate may be either
// projection of a document (`prompts edit` output, markers in, or a flat body) — `compileAuthoring`
// splices it exactly as `prompts push` would, so what is scored is what publishing would ship.
const instructions = async (live: Contract, candidate?: string): Promise<{ system: string; label: string }> =>
	candidate
		? { system: compileAuthoring(await readFile(candidate, "utf8")), label: candidate }
		: { system: live.body, label: `live v${live.version} (${live.hash})` };

// gtPath(id, prompt) — where a graded prompt's ground truth lives: one YAML per prompt, beside the
// agent (`reply_ground_truth.yaml`, `qualify_ground_truth.yaml`). Convention, not config — an agent
// has one file per prompt it grades, so nothing needs declaring. What is INSIDE differs by whether a
// human ruled on the prompt (a pointer vs a self-contained fixture); where it sits does not.
const gtPath = (id: string, prompt: string): string => join("agents", id, `${prompt}_ground_truth.yaml`);

const HEADER = `# Ground truth for the reply judge — one entry per REVIEWED decision, refreshed by
#   sflock eval cases --agent <agent> --prompt <prompt>
# which UPSERTS on \`id\` and never touches an entry that is already here: your edits and comments
# survive every re-pull, which is the whole reason this is a file and not a query.
#
# \`good\` is the output you committed (the judge must pass it); \`bad\` is the draft you replaced
# (it must fail). The EVIDENCE is not copied here — it is read from the Decision itself, so a case
# is scored against the row, exactly as the qualification eval does.
#
# A case that is not ground truth gets a \`skip:\` naming why, rather than being deleted — a
# deletion is silently undone by the next pull, and the reason is worth keeping.
`;

// harvest(ctx) — the corpus AS THE CRM HAS IT: every reviewed Decision of the graded kind.
// `feedbackOf` is the one extractor of the human delta, so an overturn's `from` (the judge's
// original) IS the negative and its `to` the positive; with no overturn the committed output is the
// model's own, which is the model-written positive the set needs. This is the SOURCE; the file
// below is the curated artifact, and the eval reads the file.
const harvest = async ({ store, reviewer, agent, kind }: Ctx): Promise<Case[]> => {
	const rows = await queryAll(store, agent.config.models.Decisions, {
		property: "Final output",
		rich_text: { is_not_empty: true }
	});
	return rows.flatMap((r) => {
		const name = String(r.fields.Name ?? r.id);
		if (reviewer.kindOf(name) !== kind) return [];
		const fb = feedbackOf(r.fields);
		return {
			id: r.id,
			name,
			input: JSON.parse(String(r.fields.Input)) as Record<string, string>,
			good: JSON.parse(String(r.fields["Final output"])) as Record<string, unknown>,
			...(fb?.outputChange ? { bad: fb.outputChange.from as Record<string, unknown> } : {}),
			...(fb?.note ? { note: fb.note } : {})
		};
	});
};

// pullCases — refresh the ground-truth file from the CRM, ADDITIVELY. An entry already in the file
// is left exactly as it is (its text, its `skip`, its comments); only decisions the file has never
// seen are appended. That is what makes the file curatable: reviewing more never overwrites the
// judgement you already recorded about a case, and a `skip` can never be silently resurrected.
// Comments survive because the merge edits the parsed DOCUMENT, not a re-serialised object tree.
export const pullCases = async (id: string, prompt: string) => {
	const ctx = await load(id, prompt);
	const path = gtPath(id, prompt);
	const existing = await readFile(path, "utf8").catch(() => "");
	const doc = existing.trim() ? parseDocument(existing) : parseDocument(`${HEADER}[]`);
	const seq = doc.contents as unknown as { items: unknown[]; add: (v: unknown) => void };
	const seen = new Set((doc.toJS() as { id: string }[] | null)?.map((e) => e.id) ?? []);
	const fresh = (await harvest(ctx)).filter((c) => !seen.has(c.id));
	// The frozen Input is deliberately NOT written: it lives on the Decision, and copying it here
	// would be a second record of evidence the CRM owns — stale the moment a renderer improves.
	for (const c of fresh)
		seq.add(doc.createNode({ id: c.id, name: c.name, good: c.good, ...(c.bad ? { bad: c.bad } : {}), ...(c.note ? { note: c.note } : {}) }));
	// Block style, always — a seeded `[]` parses as a FLOW sequence and every appended entry inherits
	// it, producing one unreadable line per case. The file exists to be hand-edited; that is the point.
	if (isSeq(doc.contents)) doc.contents.flow = false;
	if (fresh.length || !existing) await writeFile(path, doc.toString({ lineWidth: 0, blockQuote: "literal" }));
	return { path, added: fresh.length, total: seen.size + fresh.length, kept: seen.size };
};

// casesOf(ctx) — the ground truth the eval actually scores: the FILE, joined to each Decision's
// frozen evidence. Labels are the file's (so a hand correction is authoritative and diffable);
// evidence is the row's (so it is never a stale copy) — the same split reddit_qualified_threads.yaml
// already uses. A `skip`ped entry is reported and never scored.
const casesOf = async (ctx: Ctx, id: string, prompt: string): Promise<{ cases: Case[]; skipped: number }> => {
	const path = gtPath(id, prompt);
	const raw = await readFile(path, "utf8").catch(() => {
		throw new Error(`no ground truth at ${path} — run \`sflock eval cases --agent ${id} --prompt ${prompt}\` first`);
	});
	const entries = (parse(raw) ?? []) as (Omit<Case, "input"> & { skip?: string })[];
	const live = entries.filter((e) => !e.skip);
	const cases = await mapLimit(live, async (e) => ({
		...e,
		input: JSON.parse(String((await ctx.store.get(e.id)).fields.Input)) as Record<string, string>
	}));
	return { cases, skipped: entries.length - live.length };
};

// rule(ctx, system, input, output) — the SCORER, run once. The judge's evidence is the graded
// prompt's own Input with its Output spliced on, which is why no new renderer exists: it is just
// another field map, so the agent's `renderEvidence` draws it (the Thread as its Reddit card, the
// reply as prose). Held to the judge's declared Input schema first — a drift between what the
// judge asks for and what we hand it must be loud, not silently judged on a missing field.
const rule = async (
	{ agent }: Ctx,
	judge: Contract,
	system: string,
	input: Record<string, string>,
	output: Record<string, unknown>
): Promise<{ valid: boolean; why: string[] }> => {
	const evidence = { ...input, ...Object.fromEntries(Object.entries(output).map(([k, v]) => [k, String(v)])) };
	const err = schemaError(judge.inputSchema, evidence);
	if (err) throw new Error(`the judge's evidence violates its Input schema: ${err}`);
	// One retry, and only for the step-budget miss: temperature 0 does not make a tool loop
	// deterministic, and a scorer that drops a whole run because one call wandered is measuring the
	// weather. A retry that fails again throws — the caller reports it as an ERRORED case, never as
	// a verdict, because "we could not score this" and "this is invalid" are different facts.
	const ruled = () =>
		runJudgment(
			{ system, evidence: agent.renderEvidence(evidence), outputSchema: judge.outputSchema },
			agent.config.model
		);
	const v = await ruled().catch(() => ruled());
	// `{valid}` alone is the whole Output schema — the WHY rides free on every judgment, as the
	// quote-anchored statements `runJudgment` already returns. A rubric field would be a second
	// place for the reasoning to live, and a score that drifts between judge versions.
	return { valid: !!(v.output as { valid?: boolean }).valid, why: v.statements.map((s) => s.claim) };
};

// cases(id, prompt) — the corpus as the CLI asks for it: by agent + prompt key, no Ctx to build.
// evalJudge — does the scorer agree with the human? Each case is one or two assertions: the
// committed output MUST pass, the overturned draft MUST fail. Nothing here re-generates anything;
// the texts are the ones a person actually ruled on.
export const evalJudge = async (id: string, prompt: string, candidate?: string) => {
	const ctx = await load(id, prompt);
	const judge = await scorerOf(ctx);
	const { system, label } = await instructions(judge, candidate);
	const { cases: corpus, skipped } = await casesOf(ctx, id, prompt);
	if (skipped) console.error(`${skipped} case(s) skipped by the ground truth`);
	if (!corpus.length) throw new Error(`no reviewed "${ctx.kind}" decisions — nothing to calibrate against`);
	const rows = await mapLimit(corpus, async (c) => {
		const checks: { text: string; expect: boolean }[] = [{ text: "committed", expect: true }];
		if (c.bad) checks.push({ text: "overturned", expect: false });
		return {
			c,
			got: await mapLimit(checks, async (k) => {
				// A case that cannot be scored is reported, never counted — `batch`'s rule (surface an
				// error AS DATA, never substitute a fake result). Folding it into either column would
				// silently move the number the whole loop is read off.
				const v = await rule(ctx, judge, system, c.input, k.text === "committed" ? c.good : c.bad!).catch(
					(e: unknown) => ({ error: renderError(e) }) as const
				);
				return { ...k, ...v };
			})
		};
	});
	const all = rows.flatMap((r) => r.got);
	const scored = all.filter((g): g is typeof g & { valid: boolean } => "valid" in g);
	return {
		label,
		// The two classes, reported apart: a judge that passes everything scores well on a corpus of
		// positives alone, which is exactly the corpus a young review history produces.
		positives: scored.filter((g) => g.expect),
		negatives: scored.filter((g) => !g.expect),
		errored: all.length - scored.length,
		rows
	};
};

// evalReply — does the drafter satisfy the scorer? Two case sources, and the difference is what
// they cost: the labelled corpus (frozen evidence, so a run is reproducible and the human's own text
// prints beside the candidate's), or live threads picked by the agent's own selector (unlabelled,
// unlimited — the point of having a judge at all is that grading no longer needs a label).
export const evalReply = async (
	id: string,
	prompt: string,
	candidate?: string,
	select?: { tier?: string; limit?: number; subreddit?: string[] }
) => {
	const ctx = await load(id, prompt);
	const judge = await scorerOf(ctx);
	const graded = await ctx.reviewer.showPrompt(ctx.kind);
	const { system, label } = await instructions(graded, candidate);
	// The agent's own funnel module — the ONE thing core cannot derive: how to resolve a subject and
	// how to name a set of them. Imported dynamically, and only on the path that needs it, so the
	// roster stays static-import-only and the app's bundle never sees tools.ts. Same convention
	// `sflock bind` uses for a source's script manifest (src/cli.ts).
	const { decider, tools } = (await import(`../agents/${id}/tools.js`)) as AgentFunnel;
	const subjects: { name: string; subject: string | Subject; mine?: Record<string, unknown> }[] = select
		? (await tools.threads.get(select)).map((t) => ({ name: String(t.title ?? t.url), subject: t.url }))
		: (await casesOf(ctx, id, prompt)).cases.map((c) => ({
				name: c.name,
				// A Subject synthesised from the FROZEN Input — the evidence the human ruled on, handed
				// to the runtime's own context builder rather than re-read from a thread that has moved.
				subject: { key: c.id, name: c.name, fields: c.input },
				mine: c.good
			}));
	if (!subjects.length) throw new Error("nothing selected — no threads to grade");
	const rows = await mapLimit(subjects, async (s) => {
		const jc = await decider.judgmentContext(prompt, s.subject);
		const drafted = await runJudgment({ ...jc, system }, ctx.agent.config.model);
		// `jc.input` — the very map the drafter was shown, so the judge rules on the same evidence
		// rather than on a second projection that could differ. An unscoreable thread is reported,
		// never counted: a sweep loses its whole answer otherwise, for one wandering tool loop.
		const v = await rule(ctx, judge, judge.body, jc.input, drafted.output).catch(
			(e: unknown) => ({ error: renderError(e) }) as const
		);
		return { ...s, drafted: drafted.output, ...v };
	});
	return { label, judge: `v${judge.version} (${judge.hash})`, rows };
};

// ─── evalQualify — the third question, and the one that needs no model to answer ────────────────
//
// Does the judgment produce the LABEL you recorded? For a prompt whose Output is checkable — an
// enum, a boolean, a number — the ground truth IS the answer, so `===` settles it and no scorer
// exists. That is the whole difference from evalJudge/evalReply, and it is why this one is cheap
// enough to run on every edit.
//
// Its corpus is a FILE and it is SELF-CONTAINED, which is the opposite of the reply corpus and for
// a reason that is not taste. A reviewed prompt has a Decision that FROZE the evidence, so pointing
// at the row is safe. A calibrated prompt has no Decision: the row is live state, and a re-scan
// moves it under a label a human wrote weeks ago (measured — three threads lost the comment trees
// their verdicts rested on overnight). So the fixture carries its own evidence, the eval never
// touches the store, and a run is reproducible, diffable and offline.
//
// Faithful anyway, because the two functions that turn a row into evidence are the runtime's own:
// `projectInput` against the live Input schema, then the agent's `renderEvidence`. A fixture is
// just the field map a row would have presented.

export interface Fixture {
	key: string; // the subject's identity (a thread URL) — how a case is named and `--only`-matched
	expect: Record<string, unknown>; // the Output the human recorded, held to the prompt's own schema
	fields: Record<string, unknown>; // the evidence, one entry per Input-schema field
	note?: string; // the RULE this case pins — why it is in the corpus at all
	skip?: string; // not ground truth (yet): reported, never scored
}

// A fixture's evidence as `projectInput` wants it. A value that is not already a scalar is
// YAML-stringified — a Reddit thread's seed IS a document, and a corpus a human curates has to show
// it as one rather than as a quoted blob on one line.
const fieldsOf = (fields: Record<string, unknown>): Record<string, string> =>
	Object.fromEntries(
		Object.entries(fields).map(([k, v]) => [
			k,
			typeof v === "string" ? v : stringify(v, { lineWidth: 0 }).trimEnd()
		])
	);

// Does the produced Output satisfy the recorded label? `expect` is a partial Output, so only the
// keys it names are compared — a label records the decision, not every field the schema allows.
const matches = (expect: Record<string, unknown>, got: Record<string, unknown>): boolean =>
	Object.entries(expect).every(([k, v]) => JSON.stringify(got[k]) === JSON.stringify(v));

// The agent's optional evidence REDUCTION — what an earlier, cheaper read of the same subject saw.
// Core cannot derive it (only the agent knows which field a later stage adds), and it is the one
// thing this eval checks that a plain label comparison cannot: a funnel that reads twice on growing
// evidence can DROP a subject on the first read, and a subject dropped there is never fetched, so
// the verdict scored below would never have been reached in production. That miss leaves no trace
// anywhere else — it is eliminating on the ABSENCE of evidence, which the funnel's invariants forbid.
interface Reducible {
	preScreen?: (input: Record<string, string>) => Record<string, string> | null;
}

export const evalQualify = async (id: string, prompt: string, candidate?: string, only?: string[]) => {
	const ctx = await load(id, prompt);
	const graded = await ctx.reviewer.showPrompt(ctx.kind);
	const { system, label } = await instructions(graded, candidate);
	const path = gtPath(id, prompt);
	const raw = await readFile(path, "utf8").catch(() => {
		throw new Error(`no ground truth at ${path}`);
	});
	const all = (parse(raw) ?? []) as Fixture[];
	const picked = only?.length ? all.filter((f) => only.some((o) => f.key.includes(o))) : all;
	const live = picked.filter((f) => !f.skip);
	if (!live.length) throw new Error(`no cases selected in ${path}`);
	// Every label held to the graded prompt's OWN Output schema, before a single call is made. This
	// is the one gate `src/output.ts` exists to be (the LLM's output, the human's Confirm and now the
	// corpus all pass it), and it kills a whole silent class: a mistyped label — `t1` for `T1` — used
	// to be a case that could never pass and never error, i.e. a permanent invisible miss.
	for (const f of live) {
		const err = schemaError(graded.outputSchema, f.expect);
		if (err) throw new Error(`${path}: ${f.key} — \`expect\` is not a valid Output: ${err}`);
	}
	// The pre-screen reduction, if this agent declares one. Dynamic import on the one path that needs
	// it, the convention `evalReply` already uses.
	const { preScreen } = (await import(`../agents/${id}/tools.js`)) as Reducible;
	const advances = ctx.spec.resolve && ((o: Record<string, unknown>) => ctx.spec.resolve!(o).advances);

	const rows = await mapLimit(live, async (f) => {
		const input = projectInput(fieldsOf(f.fields), graded.inputSchema);
		const run = (i: Record<string, string>) =>
			runJudgment(
				{ system, evidence: ctx.agent.renderEvidence(i), outputSchema: graded.outputSchema },
				ctx.agent.config.model
			).then((v) => v);
		const v = await run(input).catch((e: unknown) => ({ error: renderError(e) }) as const);
		if ("error" in v) return { f, error: v.error };
		const reduced = preScreen?.(input);
		// Nothing to strip ⇒ the earlier read IS this read; don't pay for it twice.
		const pre = reduced ? (await run(reduced).catch(() => null))?.output : v.output;
		return {
			f,
			got: v.output,
			pre,
			twoPhase: !!reduced,
			exact: matches(f.expect, v.output),
			// The GATE agreement, and it is `resolve` that defines it — the ONE declaration of which
			// outcome advances the pipeline (config.ts). A wrong tier that still engages is a much
			// smaller error than one that drops a thread, and only the spec knows which is which.
			gate: advances ? advances(f.expect) === advances(v.output) : undefined,
			// The pre-screen killed something the truth engages: louder than a wrong label.
			killed: !!(advances && pre && !advances(pre) && advances(f.expect)),
			claims: v.statements.map((s) => `${s.supporting ? "+" : "-"} ${s.claim}`)
		};
	});
	return { label, path, skipped: picked.length - live.length, rows };
};
