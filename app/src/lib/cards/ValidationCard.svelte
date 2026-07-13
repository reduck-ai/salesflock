<script lang="ts">
	// One card, no gestures: read it, optionally leave feedback, then Reject (red) or
	// Accept (green). Presentational — it owns the feedback field (which resets for free
	// when the next card mounts) and emits a verdict; what that verdict means is the
	// caller's business. Section bodies are markdown, rendered through the one primitive.
	import { Badge } from "$lib/components/ui/badge/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import * as Card from "$lib/components/ui/card/index.js";
	import Markdown from "$lib/components/Markdown.svelte";
	import type { CardModel, Verdict } from "./types";

	let { card, onjudge }: { card: CardModel; onjudge?: (verdict: Verdict, feedback: string) => void } =
		$props();

	let feedback = $state("");
	const decide = (verdict: Verdict) => onjudge?.(verdict, feedback.trim());
</script>

<Card.Root class="shadow-lg">
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

	<Card.Content class="max-h-80 space-y-3 overflow-y-auto text-sm">
		{#each card.sections as s, i (i)}
			<div class:text-muted-foreground={s.muted}>
				{#if s.label}<p class="mb-1 font-medium">{s.label}</p>{/if}
				<Markdown source={s.body} />
			</div>
		{/each}
	</Card.Content>

	<Card.Footer class="flex-col gap-3">
		<textarea
			bind:value={feedback}
			rows="2"
			placeholder="Optional feedback…"
			class="border-input bg-background focus-visible:ring-ring w-full resize-none rounded-md border px-3 py-2 text-sm focus-visible:ring-1 focus-visible:outline-none"
		></textarea>
		<div class="flex w-full gap-2">
			<Button class="flex-1 bg-red-600 text-white hover:bg-red-700" onclick={() => decide("rejected")}>
				Reject
			</Button>
			<Button
				class="flex-1 bg-green-600 text-white hover:bg-green-700"
				onclick={() => decide("accepted")}
			>
				Accept
			</Button>
		</div>
	</Card.Footer>
</Card.Root>
