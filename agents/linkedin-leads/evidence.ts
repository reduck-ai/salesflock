// The evidence seam — the ONE renderer, shared by the judge (tools.ts), the review app
// ($agent/evidence), and the migration. A Decision freezes the lossless input MAP (the seed);
// presentation is derived from it here, so improving this renderer reflows every Decision on
// read — no re-judge. Kept dependency-light on purpose (markdown + yaml only, no ajv) so the app
// can import it without pulling projection machinery into its bundle; `projectInput` lives in
// ./project.ts (judge/migration only).

import { markdown } from "../../src/markdown.js";
import { renderActivity } from "./activity.js";

// Per-field renderer: Activity mirrors LinkedIn's UI; everything else is generic Markdown.
const renderers: Record<string, (v: string) => string> = { Activity: renderActivity };

// The lossless input map → one Markdown document, a `### field` section each — verbatim values,
// so a quote resolves against it. The judge reads this as its prompt; the app renders the same
// from the frozen map. One renderer, every caller.
export const renderEvidence = (input: Record<string, string>): string =>
	Object.entries(input)
		.map(([k, v]) => `### ${k}\n\n${(renderers[k] ?? markdown)(v)}`)
		.join("\n\n");
