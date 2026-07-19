// Project a Person's fields onto a Prompt's Input schema — the schema names the evidence — and
// hold the projection to that contract. Returns the lossless {field: value} map, in schema order,
// which is what a Decision freezes as `Input`. Judge-side + migration only: it needs `ajv`, so it
// lives apart from `evidence.ts` (the shared renderer) to keep `ajv` out of the app's bundle.

import { Ajv } from "ajv";

const ajv = new Ajv();

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
