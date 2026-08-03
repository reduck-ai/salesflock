// The LLM seam — a prompt and a schema in, the schema-shaped JSON out. WHICH model runs is agent
// semantics, not deployment state: the caller passes a "provider/modelId" string — e.g.
// "google/gemini-3.5-flash" or "bedrock/us.anthropic.claude-sonnet-4-6" — declared in the agent's
// config.ts (`model`), never injected through env. Env carries only credentials: GEMINI_API_KEY
// for google; the ambient AWS chain (AWS_PROFILE / AWS_REGION, default us-east-1) for bedrock.
// Temperature 0 always: a decision is a pure function of its context, so the model must be
// deterministic. Structured output is the AI SDK's generateObject — it unifies
// Gemini's responseSchema and Claude's tool-use behind the same schema-in/object-out contract.

import { generateObject, generateText, jsonSchema, stepCountIs, tool, type LanguageModel, type ToolSet } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { log } from "../log.js";

// NO CONCURRENCY GATE. There was one — a global 8, a number taken from Bedrock ("429s at even 2
// concurrent") and charged to every provider. It cost 3x on the qualify corpus (75s against 22s) and
// bought nothing measurable: across ~15 full-corpus runs at widths from 8 to 54, not one 429.
//
// A provider DOES fail, but the failure is a STALL, not a refusal — a request that is simply never
// answered. Measured: single calls of 163s, 172s and 264s while every healthy call finished inside
// 28s, always with zero throttles. It is exogenous (it appeared partway through a heavy session and
// grew more frequent) and it does NOT track concurrency: 32 stalled in two runs of three, 49 in none
// of two. A width was tried as the cure and is not one.
//
// So the two failure modes get the two mechanisms that can actually see them, and neither is a width:
//   a loud refusal (429)  → RATE below: back off and retry.
//   a silent stall        → DEADLINE below: a request past it is presumed dead, aborted, retried.
// Without the deadline a single stall IS the run's wall time (264s observed on a 22s corpus); with
// it, the damage is bounded to one deadline plus a retry. 45s is ~1.6x the slowest honest call.
const DEADLINE = 45_000;
const RATE = /too many requests|\b429\b|throttl|rate.?limit|resource.?exhausted/i;
// An aborted deadline surfaces as a timeout rather than a rate limit, so it needs its own pattern —
// but the response is the same (try again), which is why it shares the one retry path.
const STALL = /abort|timed? ?out|timeout/i;
const withRetry = async <T>(fn: () => Promise<T>, label: string): Promise<T> => {
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (e) {
			const why = (e as Error).message;
			const stalled = STALL.test(why);
			if (attempt >= 4 || !(RATE.test(why) || stalled)) throw e;
			const wait = 1000 * 2 ** attempt;
			log("llm", `${label} ${stalled ? `stalled past ${DEADLINE}ms` : "rate-limited"}, retry ${attempt + 1}/4 in ${wait}ms`);
			await new Promise((r) => setTimeout(r, wait));
		}
	}
};

export const DEFAULT_MODEL = "google/gemini-3.5-flash";

// "provider/modelId" → a resolved model handle, memoized (a provider client is a client). Parse
// loud: an unknown provider is a config bug, not a fallback.
type Model = LanguageModel & { provider: string; modelId: string };
const models = new Map<string, Model>();
const modelFor = (spec: string): Model => {
	const cached = models.get(spec);
	if (cached) return cached;
	const [provider, ...rest] = spec.split("/");
	const id = rest.join("/");
	if (!id) throw new Error(`model "${spec}" is not "provider/modelId"`);
	let m: Model;
	if (provider === "bedrock")
		m = createAmazonBedrock({
			region: process.env.AWS_REGION ?? "us-east-1",
			credentialProvider: fromNodeProviderChain()
		})(id) as Model;
	else if (provider === "google") {
		if (!process.env.GEMINI_API_KEY) throw new Error("set GEMINI_API_KEY");
		m = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY })(id) as Model;
	} else throw new Error(`model "${spec}": unknown provider "${provider}" (google | bedrock)`);
	models.set(spec, m);
	return m;
};

// The model identity a Decision stamps next to its judgment, 1:1 with the AI SDK's own naming
// (e.g. "amazon-bedrock/us.anthropic.claude-sonnet-4-6") — resolved, so it names what actually ran.
export const modelName = (spec = DEFAULT_MODEL): string => {
	const m = modelFor(spec);
	return `${m.provider}/${m.modelId}`;
};

// Structured output wants closed objects: every `object` node must declare additionalProperties:false
// (Claude rejects the schema otherwise). Deep-set it so any prompt's Output schema is accepted as-is.
const strict = (s: unknown): unknown => {
	if (Array.isArray(s)) return s.map(strict);
	if (!s || typeof s !== "object") return s;
	const o = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, strict(v)]));
	if (o.type === "object") o.additionalProperties = false;
	return o;
};

// generate(prompt, schema, model?) — the prompt in, the schema-shaped JSON out.
export const generate = async <T>(prompt: string, schema: object, spec = DEFAULT_MODEL): Promise<T> => {
	const model = modelFor(spec);
	log("llm", `${model.modelId} generate …`);
	const t0 = Date.now();
	const { object } = await withRetry(
		() =>
			generateObject({
				model,
				schema: jsonSchema<T>(strict(schema) as never),
				prompt,
				temperature: 0,
				abortSignal: AbortSignal.timeout(DEADLINE)
			}),
		`${model.modelId} generate`
	);
	log("llm", `${model.modelId} generate done (${Date.now() - t0}ms)`);
	return object;
};

// jsonTool — a tool from a JSON Schema, closed the same way `generate`'s schema is (Claude/Bedrock
// reject open objects). `strict` makes providers that support it emit only schema-valid tool calls,
// cutting malformed-arg round-trips before our own gate. `execute` gets the validated input and its
// return is fed back to the model.
export const jsonTool = <I>(def: {
	description: string;
	schema: object;
	execute: (input: I) => unknown | Promise<unknown>;
}) =>
	tool({
		description: def.description,
		inputSchema: jsonSchema<I>(strict(def.schema) as never),
		strict: true,
		execute: (input) => Promise.resolve(def.execute(input))
	});

// agent(prompt, tools, done, model?) — the multi-step tool loop: run until `done()` (the caller's
// success flag — e.g. a valid decision was submitted) or the step budget. `generate`'s one-shot
// generateObject can't loop over tools; this is the same contract as a loop, temperature 0.
export const agent = (prompt: string, tools: ToolSet, done: () => boolean, spec = DEFAULT_MODEL, maxSteps = 10) => {
	const model = modelFor(spec);
	log("llm", `${model.modelId} …`);
	const t0 = Date.now();
	return withRetry(
		() =>
			generateText({
				model,
				tools,
				prompt,
				temperature: 0,
				// The deadline covers the WHOLE loop, not a step: a judgment is one conversation and only
				// its completion means anything. A fresh signal per attempt, since this closure is what
				// `withRetry` re-invokes; re-running is safe because `runJudgment` is pure.
				abortSignal: AbortSignal.timeout(DEADLINE),
				stopWhen: [done, stepCountIs(maxSteps)],
				onStepFinish: (s) =>
					log("llm", `${model.modelId} step: ${s.toolCalls.map((c) => c.toolName).join(", ") || "—"}`)
			}),
		model.modelId
	).then(
		(r) => (
			log(
				"llm",
				`${model.modelId} done: ${r.steps.length} steps, ${r.totalUsage.totalTokens ?? 0} tok, ${Date.now() - t0}ms`
			),
			r
		)
	);
};
