<script lang="ts">
	// The OUTPUT zone — the agent's proposal, rendered and edited from its Prompt Output
	// schema by @sjsf. The committed value IS the decision. The schema alone governs the
	// form; the only presentation rules are in `deriveUiSchema` (form-preset). We render just
	// the fields (`Content`) inside a form context — no <form>, no submit button — so the
	// dock's Confirm stays the one action and `$core/output.schemaError` (run by ReviewCard)
	// stays the one gate. Deep two-way binding via @sjsf's `value` Bind keeps `output`
	// reactive in the parent, exactly like the old hand-rolled form did.
	import { createForm, Content, setFormContext } from "@sjsf/form";
	import { FORM_PRESET, deriveUiSchema } from "./form-preset";
	import { autocomplete } from "./autocomplete";

	let {
		schema,
		value = $bindable(),
		id
	}: {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		schema?: Record<string, any>;
		value: Record<string, unknown>;
		id?: string; // the Decision id — present ⇒ inline autocomplete is wired over the fields
	} = $props();

	// the card remounts per decision (#key), so schema/value are stable for this form's life
	// svelte-ignore state_referenced_locally
	const form = createForm({
		...FORM_PRESET,
		schema: schema ?? { type: "object" },
		uiSchema: deriveUiSchema(schema),
		value: [() => value, (v) => (value = v as Record<string, unknown>)]
	});
	setFormContext(form);
</script>

<div class="form" {@attach (node) => (id ? autocomplete({ id })(node) : undefined)}>
	<Content />
</div>

<style>
	/* the basic theme renders plain semantic widgets with stable sjsf-* classes; style them to
	   the dock — uppercase mono labels (like the evidence field headers), full-width inputs on
	   the dock's border/ring vars, textareas that grow with their text */
	.form {
		display: flex;
		flex-direction: column;
		gap: 12px;
		font-size: 13px;
		line-height: 1.5;
	}
	/* field label + object/branch title */
	.form :global(.sjsf-label),
	.form :global(.sjsf-title) {
		display: block;
		font-family: ui-monospace, monospace;
		font-size: 10.5px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted-foreground);
		margin-bottom: 5px;
	}
	/* the meta row that holds a label + its info icon — sit them on one line */
	.form :global(.sjsf-layout:has(> .info)) {
		display: flex;
		align-items: center;
	}
	/* the agent's per-field description → a hover "i" beside the label (native title tooltip) */
	.form :global(.info) {
		display: inline-grid;
		place-items: center;
		width: 14px;
		height: 14px;
		margin-left: 6px;
		vertical-align: -2px;
		border: 1px solid var(--border);
		border-radius: 50%;
		font-family: ui-serif, Georgia, serif;
		font-style: italic;
		font-weight: 600;
		font-size: 9.5px;
		line-height: 1;
		color: var(--muted-foreground);
		text-decoration: none;
		cursor: help;
	}
	.form :global(.info:hover) {
		color: var(--foreground);
		border-color: var(--ring);
	}
	.form :global(.sjsf-text),
	.form :global(.sjsf-textarea),
	.form :global(.sjsf-select) {
		width: 100%;
		padding: 7px 10px;
		border: 1px solid var(--input);
		border-radius: 9px;
		background: var(--card);
		color: var(--foreground);
		font: inherit;
	}
	.form :global(.sjsf-textarea) {
		resize: none;
		field-sizing: content;
	}
	.form :global(.sjsf-text:focus),
	.form :global(.sjsf-textarea:focus),
	.form :global(.sjsf-select:focus) {
		outline: none;
		border-color: var(--ring);
		box-shadow: 0 0 0 3px color-mix(in oklch, var(--ring) 30%, transparent);
	}
	/* a nested object / anyOf branch (e.g. the drafted next step) — grouped, no box chrome */
	.form :global(fieldset) {
		display: flex;
		flex-direction: column;
		gap: 12px;
		border: none;
		border-top: 1px solid var(--border);
		padding: 10px 0 0;
		margin: 2px 0 0;
	}
	.form :global(input[readonly]) {
		opacity: 0.65;
	}
</style>
