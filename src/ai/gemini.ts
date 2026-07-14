// Minimal Gemini client — one JSON-mode generateContent call over plain fetch, no SDK.
// GEMINI_API_KEY from env; GEMINI_MODEL overrides the default. Temperature 0 always:
// a judgment is a pure function of its context, so the judge must be deterministic.

const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash";
const API = "https://generativelanguage.googleapis.com/v1beta/models";

// generate(prompt, schema) — the prompt in, the schema-shaped JSON out.
export const generate = async <T>(prompt: string, schema: object): Promise<T> => {
	const key = process.env.GEMINI_API_KEY;
	if (!key) throw new Error("set GEMINI_API_KEY");
	const res = await fetch(`${API}/${MODEL}:generateContent`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-goog-api-key": key },
		body: JSON.stringify({
			contents: [{ role: "user", parts: [{ text: prompt }] }],
			generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0 }
		})
	});
	if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
	const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
	const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
	if (!text) throw new Error("Gemini returned no text");
	return JSON.parse(text) as T;
};
