// The output gate — one contract, one check. A committed output is valid iff it satisfies its
// Prompt's Output JSON Schema, and there is exactly one place that decides so: this. Every output
// passes through it — the LLM judge's (runtime), the human's Confirm and the server write (the
// review app) — so the human is held to precisely what the LLM is. Returns the violation, or null.

import { Ajv } from "ajv";

const ajv = new Ajv();

export const schemaError = (schema: object, data: unknown): string | null =>
	ajv.validate(schema, data) ? null : ajv.errorsText(ajv.errors);
