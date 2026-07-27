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
	const { object } = await generateObject({
		model,
		schema: jsonSchema<T>(strict(schema) as never),
		prompt,
		temperature: 0
	});
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
	return generateText({
		model,
		tools,
		prompt,
		temperature: 0,
		stopWhen: [done, stepCountIs(maxSteps)],
		onStepFinish: (s) =>
			log("llm", `${model.modelId} step: ${s.toolCalls.map((c) => c.toolName).join(", ") || "—"}`)
	}).then(
		(r) => (
			log(
				"llm",
				`${model.modelId} done: ${r.steps.length} steps, ${r.totalUsage.totalTokens ?? 0} tok, ${Date.now() - t0}ms`
			),
			r
		)
	);
};
