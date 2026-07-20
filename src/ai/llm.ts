// The LLM judge — a prompt and a schema in, the schema-shaped JSON out. One call, one seam:
// the backend is swapped by LLM_PROVIDER (google | bedrock), so the caller never knows which
// model judged. Temperature 0 always: a judgment is a pure function of its context, so the
// judge must be deterministic. Structured output is the AI SDK's generateObject — it unifies
// Gemini's responseSchema and Claude's tool-use behind the same schema-in/object-out contract.

import { generateObject, generateText, jsonSchema, stepCountIs, tool, type ToolSet } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

const provider = process.env.LLM_PROVIDER ?? "google";

// Resolved once, like a client. Google authenticates with GEMINI_API_KEY; Bedrock signs with
// the ambient AWS credential chain (SSO profile via AWS_PROFILE), so no key lives in env.
const model =
	provider === "bedrock"
		? createAmazonBedrock({
				region: process.env.AWS_REGION ?? "us-east-1",
				credentialProvider: fromNodeProviderChain()
			})(process.env.LLM_MODEL ?? "us.anthropic.claude-sonnet-4-6")
		: createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY })(
				process.env.LLM_MODEL ?? "gemini-3.5-flash"
			);

// The model's identity, 1:1 with the AI SDK's own naming — stamped onto every Decision so a
// judgment always carries the model that produced it (e.g. "amazon-bedrock/us.anthropic.claude-sonnet-4-6").
export const MODEL = `${model.provider}/${model.modelId}`;

// Structured output wants closed objects: every `object` node must declare additionalProperties:false
// (Claude rejects the schema otherwise). Deep-set it so any prompt's Output schema is accepted as-is.
const strict = (s: unknown): unknown => {
	if (Array.isArray(s)) return s.map(strict);
	if (!s || typeof s !== "object") return s;
	const o = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, strict(v)]));
	if (o.type === "object") o.additionalProperties = false;
	return o;
};

// generate(prompt, schema) — the prompt in, the schema-shaped JSON out.
export const generate = async <T>(prompt: string, schema: object): Promise<T> => {
	if (provider === "google" && !process.env.GEMINI_API_KEY) throw new Error("set GEMINI_API_KEY");
	const { object } = await generateObject({
		model,
		schema: jsonSchema<T>(strict(schema) as never),
		prompt,
		temperature: 0
	});
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

// agent(prompt, tools, done) — the multi-step judge seam: run the tool loop until `done()` (the
// caller's success flag — e.g. a valid decision was submitted) or the step budget. `generate`'s
// one-shot generateObject can't loop over tools; this is the same model, temperature 0, as a loop.
export const agent = (prompt: string, tools: ToolSet, done: () => boolean, maxSteps = 10) => {
	if (provider === "google" && !process.env.GEMINI_API_KEY) throw new Error("set GEMINI_API_KEY");
	return generateText({ model, tools, prompt, temperature: 0, stopWhen: [done, stepCountIs(maxSteps)] });
};

// runStats(result, ms) — domain-agnostic observability for a tool-loop result: wall-clock, step
// count, total tokens, and per-tool tallies of how often the model called each tool and how often a
// tool's own result said `{ok:false}`. The caller names the tools it cares about (this seam stays
// free of any one agent's vocabulary). Structural type so we don't drag in the generic result type.
export interface RunStats {
	ms: number;
	steps: number;
	tokens: number;
	calls: Record<string, number>; // toolName → times the model called it
	rejects: Record<string, number>; // toolName → times its result was { ok: false }
}
type ToolLoopResult = {
	steps: { toolCalls: { toolName: string }[]; toolResults: { toolName: string; output: unknown }[] }[];
	totalUsage: { totalTokens?: number };
};
export const runStats = (result: ToolLoopResult, ms: number): RunStats => {
	const tally = (xs: { toolName: string }[]) =>
		xs.reduce<Record<string, number>>((m, x) => ((m[x.toolName] = (m[x.toolName] ?? 0) + 1), m), {});
	return {
		ms,
		steps: result.steps.length,
		tokens: result.totalUsage.totalTokens ?? 0,
		calls: tally(result.steps.flatMap((s) => s.toolCalls)),
		rejects: tally(
			result.steps.flatMap((s) => s.toolResults).filter((r) => (r.output as { ok?: boolean }).ok === false)
		)
	};
};
