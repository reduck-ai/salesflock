// The evidence seam — the ONE renderer, shared by the judge (src/decide.ts), the review app
// ($core/linkedin/evidence), and the migration. A Decision freezes the lossless input MAP (the seed);
// presentation is derived from it here, so improving this renderer reflows every Decision on
// read — no re-judge. Kept dependency-light on purpose (markdown + yaml only, no ajv) so the app
// can import it without pulling projection machinery into its bundle; `projectInput` lives in
// ./project.ts (judge/migration only). Lives in src/linkedin/ because both LinkedIn agents
// (linkedin-leads, former-rpa-pms) and the app render the same LinkedIn evidence.

import { markdown } from "../markdown.js";
import { renderActivity } from "./activity.js";
import type { Quote } from "../anchor.js";

// Per-field renderer: Activity mirrors LinkedIn's UI; everything else is generic Markdown.
const renderers: Record<string, (v: string) => string> = { Activity: renderActivity };
const render = (k: string, v: string): string => (renderers[k] ?? markdown)(v);

// The lossless input map → one Markdown document, a `### field` section each — verbatim values,
// so a quote resolves against it. The judge reads this as its prompt; the app renders the same
// from the frozen map. One renderer, every caller.
export const renderEvidence = (input: Record<string, string>): string =>
	Object.entries(input)
		.map(([k, v]) => `### ${k}\n\n${render(k, v)}`)
		.join("\n\n");

// fieldSpan(input, key) — the [start,end) of `key`'s rendered CONTENT within renderEvidence(input),
// derived from the very sections renderEvidence joins (same `render`, same `\n\n` join — they can't
// drift). This is how CODE, never the LLM, provides a composer's anchor: the span of the field the
// output answers (e.g. an X reply's "Post"). null when the field isn't present. In schema order,
// so `projectInput`'s frozen map lines up.
export const fieldSpan = (input: Record<string, string>, key: string): Quote | null => {
	const entries = Object.entries(input);
	const i = entries.findIndex(([k]) => k === key);
	if (i < 0) return null;
	const pre = entries
		.slice(0, i)
		.map(([k, v]) => `### ${k}\n\n${render(k, v)}`)
		.join("\n\n");
	const start = (i ? pre.length + 2 : 0) + `### ${key}\n\n`.length;
	return { start, end: start + render(key, input[key]).length };
};
