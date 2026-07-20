<script lang="ts">
	// A field that renders nothing but keeps its value bound. Used (via a uiSchema
	// `ui:components` override) for the schema's readOnly arrays/objects — the `quotes`
	// anchoring layer, which lives as highlights in the evidence, not as a form control.
	// Keeping the field in the schema (just invisible) means the value passes through
	// untouched into the committed output, so the shared gate still sees it and it persists.
	let { value = $bindable() }: { value?: unknown } = $props();
	void value;
</script>
