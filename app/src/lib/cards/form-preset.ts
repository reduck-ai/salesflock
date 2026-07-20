// The one place @sjsf is wired: the fixed subsystems (theme, validator, resolver,
// translation, merger, id-builder) collapsed into a single preset so `createForm` is
// called in exactly one spot (OutputForm), and the only schema→presentation rule left.
//
// Validation is deliberately NOT the library's job here: the sole authoritative gate stays
// `$core/output.schemaError` (ajv), shared by the LLM judge, the human Confirm and the
// server write. The library still needs *a* validator to build defaults/coercions, so it
// gets the ajv8 one (same ajv the app already deduped), but its errors never surface — we
// render `<Content/>` only, never a submit, so field errors never fire.

import { resolver } from "@sjsf/form/resolvers/basic";
import { translation } from "@sjsf/form/translations/en";
import { createFormMerger } from "@sjsf/form/mergers/modern";
import { createFormIdBuilder } from "@sjsf/form/id-builders/modern";
import { createFormValidator } from "@sjsf/ajv8-validator";
import { theme } from "@sjsf/shadcn4-theme";
import "@sjsf/shadcn4-theme/extra-widgets/textarea-include"; // registers textareaWidget
import HiddenField from "./HiddenField.svelte";

export const FORM_PRESET = {
	theme,
	resolver,
	translation,
	merger: createFormMerger,
	validator: createFormValidator,
	idBuilder: createFormIdBuilder
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonSchema = Record<string, any>;

// The entire residue of our old 200-line walker: two generic rules over the Output schema.
// A readOnly array/object → hidden (kept in the value, shown as evidence highlights, not a
// control). A free-form string (no enum/format/const) → textarea. Everything else — enums,
// numbers, booleans, nested objects, anyOf, readOnly scalars — is the library's default.
export const deriveUiSchema = (schema: JsonSchema | undefined): JsonSchema => {
	const ui: JsonSchema = {};
	for (const [k, p] of Object.entries<JsonSchema>(schema?.properties ?? {})) {
		if (p?.readOnly && (p.type === "array" || p.type === "object"))
			ui[k] = {
				"ui:components": { [p.type === "array" ? "arrayField" : "objectField"]: HiddenField }
			};
		else if (p?.type === "object") ui[k] = deriveUiSchema(p);
		else if (p?.type === "string" && !p.enum && !p.format && p.const === undefined)
			ui[k] = { "ui:components": { textWidget: "textareaWidget" } };
	}
	return ui;
};
