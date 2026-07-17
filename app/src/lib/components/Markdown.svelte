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

	// snarkdown only links [text](url); our sources carry bare URLs (evidence is raw field
	// values). Linkify them in the rendered HTML's text segments — never inside a tag or an
	// existing anchor — so a URL stays clickable even when a highlight <mark> wraps it.
	const linkify = (html: string): string => {
		let inAnchor = 0;
		return html
			.split(/(<[^>]+>)/)
			.map((seg) => {
				if (seg.startsWith("<")) {
					if (/^<a[\s>]/i.test(seg)) inAnchor++;
					else if (/^<\/a>/i.test(seg)) inAnchor--;
					return seg;
				}
				if (inAnchor) return seg;
				return seg.replace(
					/https?:\/\/[^\s<>)]+[^\s<>).,;:!?]/g,
					(u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`
				);
			})
			.join("");
	};

	const html = $derived(linkify(highlights ? highlightEvidence(source, highlights) : snarkdown(source)));
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
	/* a claim's proof: always lit, subtly, in its stance's colour — light wash plus a darker
	   left bar. The cursor's claim (.active) deepens; the cursor's own quote (.current) gets
	   the ring. Stance is the claim's (.against set by the card), green by default. */
	.md :global(mark.hl) {
		--hl: #16a34a;
		background: color-mix(in oklch, var(--hl) 9%, transparent);
		box-shadow: inset 2px 0 0 color-mix(in oklch, var(--hl) 55%, transparent);
		color: inherit;
		border-radius: 3px;
		padding: 0 1px;
		transition:
			background 0.18s ease,
			box-shadow 0.18s ease;
	}
	.md :global(mark.hl.against) {
		--hl: #dc2626;
	}
	.md :global(mark.hl.active) {
		background: color-mix(in oklch, var(--hl) 18%, transparent);
		box-shadow: inset 2px 0 0 var(--hl);
	}
	.md :global(mark.hl.current) {
		box-shadow:
			inset 2px 0 0 var(--hl),
			0 0 0 1.5px color-mix(in oklch, var(--hl) 70%, transparent);
	}
</style>
