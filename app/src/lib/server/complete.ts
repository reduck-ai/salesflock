// The app's completion seam — one lean Gemini call for inline autocomplete, mirroring the app's
// own fetch-based Notion client (server/notion.ts): the review app owns thin HTTP clients for what
// it needs on Vercel, rather than importing the runtime's SDK-heavy seam (src/ai/llm.ts drags the
// bedrock + AWS providers). Text in, text out, temperature 0 like the rest of the engine. The model
// is chosen independently of the drafter (AUTOCOMPLETE_MODEL) — smaller/faster here by design.

import { env } from "$env/dynamic/private";

const MODEL = env.AUTOCOMPLETE_MODEL || "gemini-3.5-flash-lite";
const API = "https://generativelanguage.googleapis.com/v1beta/models";

// complete(prompt) — the continuation Gemini proposes for `prompt`. Short by construction (an inline
// suggestion, not an essay); temperature 0 so the same draft yields the same ghost text. Fails loud:
// a missing key or an API error throws, surfaced by the endpoint (errors never pass silently).
export const complete = async (prompt: string): Promise<string> => {
	if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
	const t0 = Date.now();
	const res = await fetch(`${API}/${MODEL}:generateContent?key=${env.GEMINI_API_KEY}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			contents: [{ parts: [{ text: prompt }] }],
			generationConfig: { temperature: 0, maxOutputTokens: 16 }
		})
	});
	if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
	const data = (await res.json()) as {
		candidates?: { content?: { parts?: { text?: string }[] } }[];
		usageMetadata?: {
			promptTokenCount?: number;
			cachedContentTokenCount?: number;
			candidatesTokenCount?: number;
			thoughtsTokenCount?: number;
		};
	};
	// One metric line per request — the first-principles decomposition: how big the prefix is
	// (prompt), how much of it cached (cached; 0 ⇒ below the implicit-cache min or a cold prefix),
	// how much we generated (out), and whether the model is secretly "thinking" (thought — should
	// be 0 for autocomplete). Read these in the dev-server log to know which latency term to cut.
	const u = data.usageMetadata ?? {};
	console.error(
		`[complete] ${MODEL} ${Date.now() - t0}ms prompt=${u.promptTokenCount ?? "?"} ` +
			`cached=${u.cachedContentTokenCount ?? 0} out=${u.candidatesTokenCount ?? "?"} ` +
			`thought=${u.thoughtsTokenCount ?? 0}`
	);
	return data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
};
