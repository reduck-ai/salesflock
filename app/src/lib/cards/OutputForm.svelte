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
		/* the one accent in a neutral palette: "inline suggestions are live" */
		--suggest: oklch(0.62 0.19 255);
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
		/* Two shadow LAYERS, each owned by one state: --glow says inline suggestions are live, --focus
		   is the focus ring. Because a state fills only its own variable, the two compose instead of
		   overriding each other — which is the whole trick, since both want `box-shadow` and the later
		   rule would otherwise win. Unset layers render as nothing. */
		box-shadow: var(--glow, 0 0 #0000), var(--focus, 0 0 #0000);
		transition: box-shadow 0.15s ease;
	}
	.form :global(.sjsf-textarea) {
		resize: none;
		field-sizing: content;
	}
	/* Suggestions live (⇧⇥ toggles it; the attachment sets the attribute) — a blue glow on the field.
	   The ACTIVE state is what is marked: off is simply the plain field, nothing decorated. Blue is
	   the one chromatic note in an otherwise neutral palette, so it reads as "the model is helping
	   here" and can't be confused with the neutral focus ring it sits inside. Same hue both themes;
	   only the halo's opacity does the work. */
	.form :global(.sjsf-textarea[data-autocomplete="on"]) {
		/* 2px, deliberately thinner than the 3px focus ring below: the two are drawn from the same edge
		   outward, so an equal spread would hide the ring entirely and a focused field would look
		   exactly like an unfocused one. Thinner means focus still adds a visible outer band. */
		/* Mixed in srgb, not oklch: --input is a hueless white, and interpolating a hue against an
		   undefined one sends the result through purple (measured: hue 302 instead of 255). */
		--glow: 0 0 0 2px color-mix(in srgb, var(--suggest) 55%, transparent);
		border-color: color-mix(in srgb, var(--suggest) 60%, transparent);
	}
	.form :global(.sjsf-text:focus),
	.form :global(.sjsf-textarea:focus),
	.form :global(.sjsf-select:focus) {
		outline: none;
		border-color: var(--ring);
		--focus: 0 0 0 3px color-mix(in oklch, var(--ring) 30%, transparent);
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
