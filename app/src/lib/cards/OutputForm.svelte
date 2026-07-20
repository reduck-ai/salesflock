<script lang="ts">
	// The OUTPUT zone — the agent's proposal, rendered and edited from its Prompt Output
	// schema by @sjsf. The committed value IS the decision. The schema alone governs the
	// form; the only presentation rules are in `deriveUiSchema` (form-preset). We render just
	// the fields (`Content`) inside a form context — no <form>, no submit button — so the
	// dock's Confirm stays the one action and `$core/output.schemaError` (run by ReviewCard)
	// stays the one gate. Deep two-way binding via @sjsf's `value` Bind keeps `output`
	// reactive in the parent, exactly like the old hand-rolled form did.
	import { createForm, Content, setFormContext } from "@sjsf/form";
	import "@sjsf/shadcn4-theme/styles.css";
	import { FORM_PRESET, deriveUiSchema } from "./form-preset";

	let {
		schema,
		value = $bindable()
	}: {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		schema?: Record<string, any>;
		value: Record<string, unknown>;
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

<div class="form">
	<Content />
</div>

<style>
	/* seat the shadcn widgets in the dock: full width, dock spacing, muted labels */
	.form {
		display: flex;
		flex-direction: column;
		gap: 10px;
		font-size: 13px;
	}
	.form :global(input),
	.form :global(textarea),
	.form :global(select) {
		width: 100%;
	}
</style>
