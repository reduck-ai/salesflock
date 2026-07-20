// The one place @sjsf is wired: the fixed subsystems (theme, validator, resolver,
// translation, merger, id-builder) collapsed into a single preset so `createForm` is
// called in exactly one spot (OutputForm), and the only schema→presentation rule left.
//
// Validation is deliberately NOT the library's job here: the sole authoritative gate stays
// `$core/output.schemaError` (ajv), shared by the LLM judge, the human Confirm and the
// server write. The library still needs *a* validator to build defaults/coercions, so it
// gets the ajv8 one (same ajv the app already deduped), but its errors never surface — we
// render `<Content/>` only, never a submit, so field errors never fire.
//
// Theme is basic (plain semantic widgets, restyled to the dock in OutputForm) — no bits-ui,
// no theme context, SSR-safe. The compat resolver maps enum → select and multi_select →
// multi-select; those field components live outside the base set, so include them.

import { resolver } from "@sjsf/form/resolvers/compat";
import { translation } from "@sjsf/form/translations/en";
import { createFormMerger } from "@sjsf/form/mergers/modern";
import { createFormIdBuilder } from "@sjsf/form/id-builders/modern";
import { createFormValidator } from "@sjsf/ajv8-validator";
import { overrideByRecord } from "@sjsf/form/lib/resolver";
import { theme as basicTheme } from "@sjsf/basic-theme";
import "@sjsf/basic-theme/extra-widgets/textarea-include"; // registers textareaWidget
import "@sjsf/form/fields/extra/enum-include"; // enum → select
import "@sjsf/form/fields/extra/multi-enum-include"; // multi_select → multi-select
import HiddenField from "./HiddenField.svelte";
import DescriptionInfo from "./DescriptionInfo.svelte";

// Field descriptions render as a hover "i", not always-on help text — one override, all fields.
// overrideByRecord (not extend) so our component wins over the theme's existing `description`.
const theme = overrideByRecord(basicTheme, { description: DescriptionInfo });

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

// A field replaced wholesale by HiddenField — no widget, no label, value preserved.
const hide = (fieldType: string) => ({ "ui:components": { [fieldType]: HiddenField } });

// snake_case / camelCase property key → a human label ("engagement_strategy" → "Engagement strategy").
const humanize = (k: string) =>
	k
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/_/g, " ")
		.replace(/^./, (c) => c.toUpperCase());

// The whole residue of our old 200-line walker: presentation derived from the schema, a few
// rules applied at every depth (objects and anyOf/oneOf branches alike):
//   • a fixed discriminator (const / single-option enum) → hidden — the anyOf branch selector
//     already names it, so showing `action` too is redundant;
//   • a readOnly array/object → hidden (kept in the value, shown as evidence highlights);
//   • a free-form editable string → textarea.
// Enums, numbers, booleans and readOnly scalars keep the library's defaults.
const uiFor = (p: JsonSchema | undefined): JsonSchema | undefined => {
	if (!p) return undefined;
	if (p.const !== undefined || (Array.isArray(p.enum) && p.enum.length === 1))
		return { "ui:components": { enumField: HiddenField, stringField: HiddenField } };
	if (p.readOnly && (p.type === "array" || p.type === "object"))
		return hide(p.type === "array" ? "arrayField" : "objectField");
	const alt = p.anyOf ?? p.oneOf;
	if (alt) return { [p.anyOf ? "anyOf" : "oneOf"]: alt.map(uiFor) };
	if (p.type === "object") return uiForProps(p);
	if (p.type === "string" && !p.readOnly && !p.enum && !p.format && p.const === undefined)
		return { "ui:components": { textWidget: "textareaWidget" } };
	return undefined;
};

// Each property carries its rule plus a humanized title (basic-theme labels default to the raw
// key). A hidden field ignores the title; nothing renders an orphan label.
const uiForProps = (schema: JsonSchema): JsonSchema => {
	const ui: JsonSchema = {};
	for (const [k, p] of Object.entries<JsonSchema>(schema.properties ?? {})) {
		ui[k] = { ...uiFor(p), "ui:options": { title: p.title ?? humanize(k) } };
	}
	return ui;
};

export const deriveUiSchema = (schema: JsonSchema | undefined): JsonSchema =>
	uiForProps(schema ?? {});
