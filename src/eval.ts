// The calibration loop, and it is two verbs that are inverses: `learn` turns a Decision into a
// CASE, `evaluate` turns cases into a SCORE. One writes the corpus, one reads it, nothing else
// touches it.
//
// ONE CORPUS SHAPE, and it is SELF-CONTAINED (`Fixture`, below). A case carries the evidence it was
// labelled on, so a run reads no store, works offline and is reproducible. The corpus used to come
// in two shapes — a pointer at the Decision for a reviewed prompt, a self-contained fixture for a
// calibrated one — and the pointer was justified by the Decision living forever. `learn` retires the
// Decision, so that premise is gone and with it the additive re-pull, the `seen` set and the store
// join every eval used to pay for.
//
// ONE GRADER, because every eval is the same sentence: run a prompt over cases, reduce each output
// to a verdict, compare the verdict to what was expected. Only the REDUCTION varies, and it has two
// forms — the output IS the verdict (a checkable Output: an enum, a boolean), or a scorer prompt
// rules on it (prose, which `===` cannot grade). Which one applies is not inferred: a scorer
// declares what it `grades` (config.ts), and three behaviours follow from that one string:
//
//   eval qualify   nothing grades it        → the output is the verdict, compared to `expect`
//   eval reply     `judge` grades it        → draft, then the scorer reduces the draft
//   eval judge     it grades `reply`        → its cases are DERIVED from reply's corpus:
//                                             `expect` must be ruled valid, `reject` invalid
//
// FAITHFUL BY CONSTRUCTION: the projection is the runtime's own (`projectInput` against the live
// Input schema, then the agent's `renderEvidence`), and a drafted case goes through the agent's own
// `judgmentContext`, swapping only the instructions — so an eval measures the code that runs, never
// a copy of it.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { AGENTS, type Agent } from "../agents/index.js";
import { createReviewer, runJudgment, type Subject } from "./decide.js";
import { promptDir, syncPrompts, type Contract } from "./prompts.js";
import { compileAuthoring } from "./stores/notion.codec.js";
import { projectInput } from "./project.js";
import { getStore, type PromptSpec, type Store } from "./stores/index.js";
import { mapLimit } from "./concurrency.js";
import { schemaError } from "./output.js";
import { renderError } from "./errors.js";

// ─── the corpus ──────────────────────────────────────────────────────────────────────────────────

// One labelled case, carrying its own evidence. `expect` is the Output that should come out (the
// one a human recorded); `reject` is the one that must not — the draft they overturned, present
// only when there was one. Both are whole Outputs of the graded prompt, held to its schema.
export interface Fixture {
	key: string; // the SUBJECT's identity (a thread URL) — the case's name, and what `--only` matches
	expect?: Record<string, unknown>;
	reject?: Record<string, unknown>;
	note?: string; // the RULE this case pins — the human's own words, moved here from the Decision
	fields: Record<string, unknown>; // the evidence, one entry per Input-schema field
	skip?: string; // not ground truth (yet), and why — reported, never scored
}

// gtPath(id, prompt) — a corpus lives IN the prompt's own folder, beside the instructions it grades
// and the schemas they are held to. Convention, not config: one judgment is one directory.
const gtPath = (id: string, prompt: string): string => join(promptDir(id, prompt), "ground_truth.yaml");

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

const corpusOf = async (id: string, prompt: string): Promise<Fixture[]> => {
	const path = gtPath(id, prompt);
	const raw = await readFile(path, "utf8").catch(() => {
		throw new Error(`no ground truth at ${path} — record one with \`sflock learn\``);
	});
	return (parse(raw) ?? []) as Fixture[];
};

// ─── the agent + its prompts ─────────────────────────────────────────────────────────────────────

interface Ctx {
	agent: Agent;
	store: Store;
	reviewer: ReturnType<typeof createReviewer>;
}

const load = async (id: string): Promise<Ctx> => {
	const agent = AGENTS[id];
	if (!agent) throw new Error(`no agent "${id}" — register it in agents/index.ts.`);
	// A drift check before anything is scored or learned: a prompt whose inlined section no longer
	// matches its source is not the prompt anyone thinks they are calibrating, so a green run on it
	// certifies nothing. The same function `sflock prompts --check` and the test call.
	const drifted = (await syncPrompts()).filter((p) => p.drifted.length);
	if (drifted.length)
		throw new Error(
			`refusing to run on a drifted prompt: ${drifted
				.map((p) => `${p.agent}/${p.key} (${p.drifted.join(", ")})`)
				.join("; ")} — run \`sflock prompts\` to re-inline from the pool.`
		);
	return { agent, store: getStore(agent.config.destination), reviewer: createReviewer(agent) };
};

const specOf = (agent: Agent, key: string): PromptSpec => {
	const spec = agent.config.prompts?.[key];
	if (!spec) throw new Error(`agent "${agent.id}" declares no prompt "${key}"`);
	return spec;
};

// scorerFor(agent, key) — the prompt that GRADES `key`, if one declares itself so. The inverse of
// `PromptSpec.grades`, and the whole of how a grading mode is chosen: found ⇒ prose, reduced by that
// scorer; not found ⇒ the Output is the verdict.
const scorerFor = (agent: Agent, key: string): { key: string; spec: PromptSpec } | undefined => {
	const hit = Object.entries(agent.config.prompts ?? {}).find(([, s]) => s.grades === key);
	return hit ? { key: hit[0], spec: hit[1] } : undefined;
};

// The instructions under test: a candidate file, or the committed one. A candidate is just a copy of
// a PROMPT.md — markers in, or already stripped — and `compileAuthoring` drops them exactly as the
// loader does, so what is scored is what committing that file would ship.
const instructions = async (live: Contract, candidate?: string): Promise<{ system: string; label: string }> =>
	candidate
		? { system: compileAuthoring(await readFile(candidate, "utf8")), label: candidate }
		: { system: live.body, label: `committed (${live.hash})` };

// ─── learn — a Decision becomes a case ───────────────────────────────────────────────────────────

// The one write into a corpus, and the one thing that retires a Decision. Atomic in the only order
// that can be: the case is written FIRST, the row is touched second — so a failure in between leaves
// the learning recorded and the row still there, and a re-run converges (the corpus upserts on
// `key`). The reverse order could destroy the evidence it was meant to preserve.
//
// `prompt` is the ONE thing a human must supply and a machine cannot infer: WHICH judgment this
// teaches. It defaults to the decision's own kind, but the interesting case is the other one — a
// note left on a reply ("this thread is off topic") is a complaint about QUALIFY, and the fix
// belongs in qualify's corpus. `projectInput` is the retargeting operator: hand it the other
// prompt's Input schema and the frozen evidence reduces to exactly the fields that judgment sees.
//
// What happens to the row follows from what the row IS, with no flag to pass. A decision that was
// APPROVED is history — it records something we actually did — so it stays and only the note moves
// (the note is a TODO; once it is a case, the TODO is done). A decision never approved is a draft
// nobody sent: it is archived, and the entity it opened is closed at `config.dropped`, because
// otherwise it waits forever on a decision that no longer exists.
export const learn = async (
	id: string,
	decision: string,
	opts: { prompt?: string; expect?: Record<string, unknown> } = {}
) => {
	const ctx = await load(id);
	const { agent, store, reviewer } = ctx;
	const shown = await reviewer.showDecision(decision);
	if (!shown.subject)
		throw new Error(
			`decision ${shown.id} carries no Subject — it predates the column, so nothing names what it ` +
				`is about. Re-cut the draft, or add the Subject by hand.`
		);

	// Which judgment this teaches, and therefore which corpus it lands in.
	const own = shown.kind ? reviewer.keyOf(shown.kind) : undefined;
	const key = opts.prompt ?? own;
	if (!key) throw new Error(`decision ${shown.id} has no Kind — name the prompt with --prompt`);
	const graded = await reviewer.prompt(key);
	const spec = specOf(agent, key);

	// The label, and it FOLLOWS FROM WHAT THE HUMAN DID — nothing to pass in the ordinary case. An
	// APPROVED decision states its own positive: the committed output is what should have come out.
	// A REFUSED one (a note, never approved — what the review app now writes) states only a NEGATIVE,
	// and that is the correction here: this used to record `shown.output` as `expect`, teaching the
	// corpus that the draft you threw away was the right answer, with the note beside it saying the
	// opposite. A refusal has no positive unless you supply one. Retargeting to another judgment
	// (`--prompt`) has neither, since the frozen Output answers a different schema — only a stated
	// `--expect` can be a label there.
	const committed = shown.review?.human.output as Record<string, unknown> | undefined;
	const mine = key === own;
	const expect = opts.expect ?? (mine && shown.review ? (committed ?? shown.output) : undefined);
	// ONE rule for the negative, and it covers all four cases: the judge's own output is the `reject`
	// whenever it is not what should have come out. Verbatim confirm ⇒ none (they agree); overturn ⇒
	// the pair; refusal ⇒ the whole label (there is no `expect`, so they differ); refusal you then
	// labelled ⇒ the pair again. Compared as JSON, so an absent `expect` is simply never equal to a
	// real output.
	const reject = mine && JSON.stringify(expect) !== JSON.stringify(shown.output) ? shown.output : undefined;
	if (expect) {
		const err = schemaError(graded.outputSchema, expect);
		if (err) throw new Error(`--expect is not a valid ${key} Output: ${err}`);
	}
	const note = shown.feedback?.note;
	// A case with no label and no stated rule teaches nothing — refuse rather than write a row that
	// can never fail and never inform.
	if (!expect && !note)
		throw new Error(
			`nothing to learn from ${shown.id}: no note on the decision and no --expect. Say what should ` +
				`have come out, or leave a note in the app first.`
		);

	// The evidence, projected onto the graded prompt's Input schema — the runtime's own projection,
	// so the case is faithful, and the retargeting is free.
	const fields = projectInput(shown.input, graded.inputSchema);

	const path = gtPath(id, key);
	const corpus = await corpusOf(id, key).catch(() => [] as Fixture[]);
	const at = corpus.findIndex((f) => f.key === shown.subject);
	const fixture: Fixture = {
		key: shown.subject,
		...(expect ? { expect } : {}),
		...(reject ? { reject } : {}),
		...(note ? { note } : {}),
		fields
	};
	// Upsert on the subject, so learning twice about one thread converges instead of forking it.
	const raw = await readFile(path, "utf8").catch(() => "");
	if (at >= 0) {
		corpus[at] = { ...corpus[at], ...fixture };
		await writeFile(path, reheader(raw) + stringify(corpus, { lineWidth: 100, blockQuote: "literal" }));
	} else {
		await writeFile(
			path,
			raw.replace(/\n*$/, "\n") + stringify([fixture], { lineWidth: 100, blockQuote: "literal" })
		);
	}

	// The row, second. Approved ⇒ history: keep it, move the note out (the note was a TODO; it is a
	// case now). Never approved ⇒ a draft nobody sent: retire it, and let the agent close the entity
	// it opened.
	const approved = !!shown.review;
	if (approved) {
		if (note) await store.patch(agent.config.models.Decisions, shown.id, { Feedback: "" });
	} else {
		await store.archive(shown.id);
		await agent.config.drop?.(shown.subject);
	}
	return {
		learned: path,
		key: shown.subject,
		prompt: key,
		...(expect ? { expect } : {}),
		...(reject ? { reject } : {}),
		...(note ? { note } : {}),
		decision: approved ? "kept — approved, so it is history" : "archived — never approved",
		...(!approved && agent.config.drop ? { entity: "dropped" } : {})
	};
};

// Rewriting the whole sequence loses the file's leading comment block, so it is carried across:
// everything above the first entry is prose a human wrote about the corpus.
const reheader = (raw: string): string => {
	const i = raw.search(/^- /m);
	return i < 0 ? raw : raw.slice(0, i);
};

// ─── evaluate — cases become a score ─────────────────────────────────────────────────────────────

// One graded case's result. `ok` is the whole verdict; everything else is why.
export interface Scored {
	name: string; // the case, named by its subject key
	ok: boolean;
	expect?: unknown;
	got?: unknown;
	why: string[]; // the claims behind the verdict
	note?: string;
	error?: string; // unscoreable — reported, never counted as agreement or disagreement
	pre?: unknown; // the pre-screen's verdict, when the agent declares one
	killed?: boolean; // the pre-screen dropped a subject the truth engages
	gate?: boolean; // the outcome advances the same way the label does (`resolve`)
}

// The agent's optional evidence REDUCTION — what an earlier, cheaper read of the same subject saw.
// Core cannot derive it (only the agent knows which field a later stage adds), and it is the one
// thing a label comparison cannot check: a funnel that reads twice on growing evidence can DROP a
// subject on the first read, and a subject dropped there is never fetched, so the verdict scored
// here would never have been reached in production. That miss leaves no trace anywhere else.
interface Funnel {
	preScreen?: (input: Record<string, string>) => Record<string, string> | null;
	decider?: {
		judgmentContext: (
			key: string,
			handle: string | Subject
		) => Promise<{ system: string; evidence: string; input: Record<string, string>; outputSchema: Record<string, unknown> }>;
	};
	tools?: { threads: { get: (select: object) => Promise<{ url: string; title: unknown }[]> } };
}

export const evaluate = async (
	id: string,
	key: string,
	candidate?: string,
	opts: { only?: string[]; tier?: string; subreddit?: string[]; limit?: number } = {}
) => {
	const ctx = await load(id);
	const { agent } = ctx;
	const spec = specOf(agent, key);
	const graded = await ctx.reviewer.prompt(key);
	const { system, label } = await instructions(graded, candidate);
	const scorer = scorerFor(agent, key);

	// WHOSE corpus. A scorer has none of its own: its cases are the prompt it grades, each read
	// twice — the recorded output must be ruled valid, the overturned one invalid.
	const from = spec.grades ?? key;
	const path = gtPath(id, from);
	const all = await corpusOf(id, from);
	const picked = opts.only?.length ? all.filter((f) => opts.only!.some((o) => f.key.includes(o))) : all;
	const live = picked.filter((f) => !f.skip);

	const funnel = (await import(`../agents/${id}/tools.js`).catch(() => ({}))) as Funnel;
	const advances = spec.resolve && ((o: Record<string, unknown>) => spec.resolve!(o).advances);
	const run = (system: string, evidence: string, outputSchema: Record<string, unknown>) =>
		runJudgment({ system, evidence, outputSchema }, agent.config.model);

	// ── a scorer grading itself: the derived corpus, no generation at all ──
	if (spec.grades) {
		const gradedSpec = await ctx.reviewer.prompt(spec.grades);
		const cases = live.flatMap((f) => [
			...(f.expect ? [{ f, out: f.expect, expect: true, side: "expect" }] : []),
			...(f.reject ? [{ f, out: f.reject, expect: false, side: "reject" }] : [])
		]);
		if (!cases.length) throw new Error(`no labelled cases in ${path} — nothing for a scorer to agree with`);
		const rows = await mapLimit(cases, async (c): Promise<Scored> => {
			const input = projectInput(fieldsOf(c.f.fields), gradedSpec.inputSchema);
			const v = await rule(agent, graded, system, input, c.out).catch((e: unknown) => ({ error: renderError(e) }) as const);
			if ("error" in v) return { name: `${c.f.key} [${c.side}]`, ok: false, error: v.error, why: [] };
			return {
				name: `${c.f.key} [${c.side}]`,
				ok: v.valid === c.expect,
				expect: { valid: c.expect },
				got: { valid: v.valid },
				why: v.why,
				...(c.f.note ? { note: c.f.note } : {})
			};
		}, { label: `eval ${key}` });
		return { label, path, mode: `scorer of ${spec.grades}`, skipped: picked.length - live.length, rows };
	}

	// ── a prompt a scorer grades: draft, then reduce with the scorer ──
	if (scorer) {
		const judge = await ctx.reviewer.prompt(scorer.key);
		// Two case sources: the labelled corpus (frozen evidence, so runs compare), or live subjects
		// picked by the agent's own selector — unlabelled and unlimited, which is the point of having
		// a scorer at all.
		const select = opts.tier || opts.subreddit || opts.limit ? { tier: opts.tier, subreddit: opts.subreddit, limit: opts.limit } : undefined;
		const subjects: { name: string; subject: string | Subject; mine?: unknown; note?: string }[] = select
			? (await funnel.tools!.threads.get(select)).map((t) => ({ name: String(t.url), subject: t.url }))
			: live.map((f) => ({
					name: f.key,
					subject: { key: f.key, name: f.key, fields: fieldsOf(f.fields) },
					mine: f.expect,
					...(f.note ? { note: f.note } : {})
				}));
		if (!subjects.length) throw new Error("nothing selected — no cases to grade");
		const rows = await mapLimit(subjects, async (s): Promise<Scored> => {
			const jc = await funnel.decider!.judgmentContext(key, s.subject);
			const drafted = await run(system, jc.evidence, jc.outputSchema);
			const v = await rule(agent, judge, judge.body, jc.input, drafted.output).catch(
				(e: unknown) => ({ error: renderError(e) }) as const
			);
			if ("error" in v) return { name: s.name, ok: false, error: v.error, why: [] };
			return {
				name: s.name,
				ok: v.valid,
				got: drafted.output,
				expect: s.mine,
				why: v.why,
				...(s.note ? { note: s.note } : {})
			};
		}, { label: `eval ${key}` });
		return { label, path, mode: `judged by ${scorer.key} (${judge.hash})`, skipped: picked.length - live.length, rows };
	}

	// ── nothing grades it: the Output IS the verdict ──
	if (!live.length) throw new Error(`no cases selected in ${path}`);
	// Every label held to the graded prompt's own Output schema BEFORE a single call. This is the one
	// gate src/output.ts exists to be, and it kills a silent class: a mistyped label (`t1` for `T1`)
	// used to be a case that could never pass and never error.
	for (const f of live) {
		if (!f.expect) throw new Error(`${path}: ${f.key} — no \`expect\`, so nothing to compare`);
		const err = schemaError(graded.outputSchema, f.expect);
		if (err) throw new Error(`${path}: ${f.key} — \`expect\` is not a valid Output: ${err}`);
	}
	const rows = await mapLimit(live, async (f): Promise<Scored> => {
		const input = projectInput(fieldsOf(f.fields), graded.inputSchema);
		const judge = (i: Record<string, string>) => run(system, agent.renderEvidence(i), graded.outputSchema);
		// The two reads are independent (`reduced` derives from `input`, never from `v`) so they COULD
		// run together. Tried, and reverted: it saved ~10s on the few two-phase cases and cost a second
		// code path to read. Sequential is what "an earlier, cheaper read" already means.
		const v = await judge(input).catch((e: unknown) => ({ error: renderError(e) }) as const);
		if ("error" in v) return { name: f.key, ok: false, error: v.error, why: [] };
		const reduced = funnel.preScreen?.(input);
		// Nothing to strip ⇒ the earlier read IS this read; don't pay for it twice.
		const pre = reduced ? (await judge(reduced).catch(() => null))?.output : v.output;
		return {
			name: f.key,
			ok: matches(f.expect!, v.output),
			expect: f.expect,
			got: v.output,
			why: v.statements.map((s) => `${s.supporting ? "+" : "-"} ${s.claim}`),
			...(f.note ? { note: f.note } : {}),
			...(reduced ? { pre } : {}),
			// The GATE agreement, and `resolve` defines it: a wrong label that still advances is a much
			// smaller error than one that drops a subject, and only the spec knows which is which.
			...(advances ? { gate: advances(f.expect!) === advances(v.output) } : {}),
			...(advances && pre && !advances(pre as Record<string, unknown>) && advances(f.expect!)
				? { killed: true }
				: {})
		};
	}, { label: `eval ${key}` });
	return { label, path, mode: "label", skipped: picked.length - live.length, rows };
};

// Does the produced Output satisfy the recorded label? `expect` is a partial Output, so only the
// keys it names are compared — a label records the decision, not every field the schema allows.
const matches = (expect: Record<string, unknown>, got: Record<string, unknown>): boolean =>
	Object.entries(expect).every(([k, v]) => JSON.stringify(got[k]) === JSON.stringify(v));

// rule(...) — the SCORER, run once. Its evidence is the graded prompt's own Input with an Output
// spliced on, which is why no new renderer exists: it is just another field map, so the agent's
// `renderEvidence` draws it. Held to the scorer's declared Input schema first — a drift between what
// it asks for and what we hand it must be loud, not silently judged on a missing field.
const rule = async (
	agent: Agent,
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
	// weather. A retry that fails again throws — "we could not score this" and "this is invalid" are
	// different facts.
	const ruled = () =>
		runJudgment(
			{ system, evidence: agent.renderEvidence(evidence), outputSchema: judge.outputSchema },
			agent.config.model
		);
	const v = await ruled().catch(() => ruled());
	return { valid: !!(v.output as { valid?: boolean }).valid, why: v.statements.map((s) => s.claim) };
};
