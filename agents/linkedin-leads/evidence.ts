// The evidence seam — the ONE renderer, shared by the judge (tools.ts), the review app
// ($agent/evidence), and the migration. A Decision freezes the lossless input MAP (the seed);
// presentation is derived from it here, so improving this renderer reflows every Decision on
// read — no re-judge. `projectInput` selects the Person fields the Prompt's Input schema names
// (and holds them to it); `renderEvidence` turns that map into the Markdown a judge/human reads.

import { Ajv } from "ajv";
import { markdown } from "../../src/markdown.js";
import { renderActivity } from "./activity.js";

const ajv = new Ajv();

// Project a Person's fields onto the Input schema — the schema names the evidence — and hold the
// projection to that contract (evidence must respect it). Returns the lossless {field: value}
// map, in schema order, which is what the Decision freezes as `Input`.
export const projectInput = (
	fields: Record<string, string | number | boolean>,
	inputSchema: Record<string, unknown>
): Record<string, string> => {
	const keys = Object.keys((inputSchema.properties as Record<string, unknown> | undefined) ?? {});
	const present = keys.filter((k) => fields[k]);
	const input = Object.fromEntries(present.map((k) => [k, String(fields[k])]));
	if (!ajv.validate(inputSchema, input))
		throw new Error(`evidence violates Input schema: ${ajv.errorsText(ajv.errors)}`);
	return input;
};

// Per-field renderer: Activity mirrors LinkedIn's UI; everything else is generic Markdown.
const renderers: Record<string, (v: string) => string> = { Activity: renderActivity };

// The lossless input map → one Markdown document, a `### field` section each — verbatim values,
// so a quote resolves against it. The judge reads this as its prompt; the app renders the same
// from the frozen map. One renderer, every caller.
export const renderEvidence = (input: Record<string, string>): string =>
	Object.entries(input)
		.map(([k, v]) => `### ${k}\n\n${(renderers[k] ?? markdown)(v)}`)
		.join("\n\n");
