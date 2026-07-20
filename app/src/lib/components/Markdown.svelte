<script lang="ts">
	// The one place markdown becomes HTML, via the app's shared renderer ($lib/md). It
	// renders the natural nested markdown our sources emit — nested lists, bold labels,
	// paragraphs — that a minimal renderer can't; the scoped styles give them shape, since
	// Tailwind's preflight strips it. Source is our own CRM text, never visitor input, so
	// {@html} is safe here — keep it that way. `highlights` (optional) wraps each resolved
	// quote span in <mark data-si> so a claim can light up its proof.
	import { renderMd } from "$lib/md";
	import { highlightEvidence } from "$lib/cards/highlight";
	import type { Quote } from "$lib/cards/types";

	let {
		source,
		class: klass = "",
		highlights
	}: { source: string; class?: string; highlights?: { si: number; q: Quote }[] } = $props();

	// marked's autolinking is off (see $lib/md), and our sources carry bare URLs (evidence is
	// raw field values). Linkify them in the rendered HTML's text segments — never inside a
	// tag or an existing anchor — so a URL stays clickable even when a highlight <mark> wraps
	// it. This is the single place URLs become links, sentinel-safe by running last.
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

	const html = $derived(linkify(highlights ? highlightEvidence(source, highlights) : renderMd(source)));
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
	.md :global(ul ul) {
		margin: 0.1rem 0;
	}
	.md :global(li) {
		margin: 0.2rem 0;
	}
	/* marked wraps a loose list item's content in <p> (Tailwind's preflight zeroes their
	   margins) — give paragraphs air so a post's text reads as prose, not one block */
	.md :global(p) {
		margin: 0.5rem 0;
	}
	.md :global(p:first-child) {
		margin-top: 0;
	}
	.md :global(p:last-child) {
		margin-bottom: 0;
	}
	.md :global(code) {
		font-family: ui-monospace, monospace;
		font-size: 0.85em;
	}
	/* a claim's proof: always lit, subtly, in its stance's colour. A quote that crosses tags or
	   lines is several <mark> fragments sharing one si/mi (highlight.ts); the wash is on every
	   fragment so the band is seamless (no padding/radius between them), while the darker left
	   bar and the cursor ring sit only on the FIRST fragment (.hl-start) — one accent per quote,
	   not stripes. The cursor's claim (.active) deepens the whole band; its own quote (.current)
	   rings its start. Stance is the claim's (.against set by the card), green by default. */
	.md :global(mark.hl) {
		--hl: #16a34a;
		background: color-mix(in oklch, var(--hl) 9%, transparent);
		color: inherit;
		cursor: pointer; /* clicking a quote focuses it — its margin comment expands */
		transition:
			background 0.18s ease,
			box-shadow 0.18s ease;
	}
	.md :global(mark.hl.hl-start) {
		box-shadow: inset 2px 0 0 color-mix(in oklch, var(--hl) 55%, transparent);
		border-top-left-radius: 3px;
		border-bottom-left-radius: 3px;
	}
	.md :global(mark.hl.against) {
		--hl: #dc2626;
	}
	/* a claim the human has noted reads gold — same --hl machinery, gold overrides stance */
	.md :global(mark.hl.noted) {
		--hl: #d97706;
	}
	/* a human-added quote reads blue — provenance wins over stance (green/red) */
	.md :global(mark.hl.userq) {
		--hl: #2563eb;
	}
	.md :global(mark.hl.active) {
		background: color-mix(in oklch, var(--hl) 18%, transparent);
	}
	.md :global(mark.hl.active.hl-start) {
		box-shadow: inset 2px 0 0 var(--hl);
	}
	.md :global(mark.hl.current.hl-start) {
		box-shadow:
			inset 2px 0 0 var(--hl),
			0 0 0 1.5px color-mix(in oklch, var(--hl) 70%, transparent);
	}
</style>
