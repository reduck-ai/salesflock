// The LLM judge — a prompt and a schema in, the schema-shaped JSON out. One call, one seam:
// the backend is swapped by LLM_PROVIDER (google | bedrock), so the caller never knows which
// model judged. Temperature 0 always: a judgment is a pure function of its context, so the
// judge must be deterministic. Structured output is the AI SDK's generateObject — it unifies
// Gemini's responseSchema and Claude's tool-use behind the same schema-in/object-out contract.

import { generateObject, jsonSchema } from "ai";
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
