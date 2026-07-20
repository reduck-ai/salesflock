<script lang="ts">
	// A field's schema description, rendered as a hover "i" instead of an always-on line of help
	// text. The text rides in a native `title` — which escapes the dock's `overflow: hidden` (a
	// CSS tooltip would be clipped) and needs zero tooltip machinery. Overrides @sjsf's default
	// `description` component globally (form-preset).
	let { description }: { description?: string } = $props();
</script>

{#if description}
	<abbr class="info" title={description} aria-label={description}>i</abbr>
{/if}
