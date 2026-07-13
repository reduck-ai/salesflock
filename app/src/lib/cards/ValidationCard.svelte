<script lang="ts">
	// One card. Presentational + the Tinder gesture: drag the top card, past a
	// threshold it flies off in the verdict's direction; buttons do the same. Cards
	// behind (depth > 0) render offset and scaled and ignore input. It knows nothing
	// about persistence — it emits a Verdict and lets the stack decide what that means.
	import { Badge } from "$lib/components/ui/badge/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import * as Card from "$lib/components/ui/card/index.js";
	import type { CardModel, Verdict } from "./types";

	let {
		card,
		depth = 0,
		interactive = false,
		ondecide
	}: {
		card: CardModel;
		depth?: number; // 0 = top; drives the stacked offset behind it
		interactive?: boolean;
		ondecide?: (verdict: Verdict) => void;
	} = $props();

	const THRESHOLD = 120; // px of drag that commits a verdict

	let dx = $state(0);
	let dragging = $state(false);
	let flung = $state(0); // -1 / +1 once decided: the card is leaving
	let startX = 0;

	// Right hints accept, left hints reject; magnitude → tint opacity.
	const hint = $derived<Verdict | null>(dx > 0 ? "accepted" : dx < 0 ? "rejected" : null);
	const tint = $derived(Math.min(Math.abs(dx) / THRESHOLD, 1));

	// Final transform: flung wins (off-screen), else the live drag; behind cards sit still.
	const x = $derived(flung ? flung * 700 : dx);
	const rot = $derived(x / 25);

	const fly = (v: Verdict) => {
		if (flung) return; // ignore repeat presses while leaving
		flung = v === "accepted" ? 1 : -1;
		ondecide?.(v);
	};

	const down = (e: PointerEvent) => {
		if (!interactive || flung) return;
		dragging = true;
		startX = e.clientX;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	};
	const move = (e: PointerEvent) => {
		if (dragging) dx = e.clientX - startX;
	};
	const up = () => {
		if (!dragging) return;
		dragging = false;
		if (hint && Math.abs(dx) >= THRESHOLD) fly(hint);
		else dx = 0;
	};
</script>

<div
	class="absolute inset-x-0 top-0 {interactive ? 'cursor-grab touch-none select-none active:cursor-grabbing' : ''} {dragging
		? ''
		: 'transition-transform duration-300'}"
	style="transform: translate({x}px, {depth * 10}px) rotate({rot}deg) scale({1 - depth * 0.05}); z-index: {50 - depth};"
	role="group"
	aria-label={card.title}
	onpointerdown={down}
	onpointermove={move}
	onpointerup={up}
	onpointercancel={up}
>
	<Card.Root class="relative overflow-hidden shadow-lg">
		{#if interactive}
			<div
				class="pointer-events-none absolute inset-0 bg-green-500/20"
				style="opacity: {hint === 'accepted' ? tint : 0}"
			></div>
			<div
				class="pointer-events-none absolute inset-0 bg-red-500/20"
				style="opacity: {hint === 'rejected' ? tint : 0}"
			></div>
		{/if}

		<Card.Header>
			<Card.Title>
				{#if card.href}
					<a href={card.href} target="_blank" rel="noreferrer" class="hover:underline">{card.title}</a>
				{:else}
					{card.title}
				{/if}
			</Card.Title>
			{#if card.badge}
				<Card.Action><Badge variant={card.badge.tone}>{card.badge.text}</Badge></Card.Action>
			{/if}
		</Card.Header>

		<Card.Content class="max-h-72 space-y-2 overflow-y-auto text-sm">
			{#each card.sections as s, i (i)}
				<p class:text-muted-foreground={s.muted}>
					{#if s.label}<span class="font-medium">{s.label}</span> · {/if}{s.body}
				</p>
			{/each}
		</Card.Content>

		{#if interactive}
			<Card.Footer class="gap-2">
				<Button variant="outline" class="flex-1" onclick={() => fly("rejected")}>Reject</Button>
				<Button class="flex-1" onclick={() => fly("accepted")}>Accept</Button>
			</Card.Footer>
		{/if}
	</Card.Root>
</div>
