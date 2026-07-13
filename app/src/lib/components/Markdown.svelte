<script lang="ts">
	// The one place markdown becomes HTML. snarkdown (~1 KB, no deps) is sufficient for
	// the headings/emphasis/lists our sources emit; the scoped styles give them shape,
	// since Tailwind's preflight strips it. Source is our own CRM text, never visitor
	// input, so {@html} is safe here — keep it that way.
	import snarkdown from "snarkdown";

	let { source, class: klass = "" }: { source: string; class?: string } = $props();
</script>

<div class="md {klass}">{@html snarkdown(source)}</div>

<style>
	.md :global(h1),
	.md :global(h2),
	.md :global(h3) {
		margin: 0.75rem 0 0.125rem;
		font-weight: 600;
	}
	.md :global(h1:first-child),
	.md :global(h2:first-child),
	.md :global(h3:first-child) {
		margin-top: 0;
	}
	.md :global(strong) {
		font-weight: 600;
	}
	.md :global(a) {
		text-decoration: underline;
	}
	.md :global(ul) {
		margin: 0.25rem 0;
		padding-left: 1.25rem;
		list-style: disc;
	}
	.md :global(code) {
		font-family: ui-monospace, monospace;
		font-size: 0.85em;
	}
</style>
