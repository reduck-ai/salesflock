<script lang="ts">
	// The one place markdown becomes HTML. snarkdown (~1 KB, no deps) is sufficient for
	// the headings/emphasis/lists our sources emit; the scoped styles give them shape,
	// since Tailwind's preflight strips it. Source is our own CRM text, never visitor
	// input, so {@html} is safe here — keep it that way. `highlights` (optional) wraps each
	// resolved quote span in <mark data-si> so a claim can light up its proof.
	import snarkdown from "snarkdown";
	import { highlightEvidence } from "$lib/cards/highlight";
	import type { Selector } from "$lib/cards/types";

	let {
		source,
		class: klass = "",
		highlights
	}: { source: string; class?: string; highlights?: { si: number; sel: Selector }[] } = $props();

	const html = $derived(highlights ? highlightEvidence(source, highlights) : snarkdown(source));
</script>

<div class="md {klass}">{@html html}</div>

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
	/* a claim's proof: invisible until its claim is active, then a soft spotlight */
	.md :global(mark.hl) {
		background: transparent;
		color: inherit;
		border-radius: 3px;
		padding: 0 1px;
		transition:
			background 0.18s ease,
			box-shadow 0.18s ease;
	}
	.md :global(mark.hl.active) {
		background: var(--hl-bg, #fff3c4);
		box-shadow: inset 2px 0 0 var(--hl-bar, #e9c96a);
	}
</style>
