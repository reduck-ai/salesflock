<script lang="ts">
	// The deck: one card at a time, advance on each verdict. The #key remounts the card
	// per id — the slide-in reads as "next one, please" and the feedback field clears
	// itself. All the state there is; ValidationCard stays pure, persistence stays the
	// caller's.
	import { fly } from "svelte/transition";
	import ValidationCard from "./ValidationCard.svelte";
	import type { CardModel, Judgment, Verdict } from "./types";

	let { cards, onjudge }: { cards: CardModel[]; onjudge?: (j: Judgment) => void } = $props();

	let index = $state(0);

	const judge = (verdict: Verdict, feedback: string) => {
		onjudge?.({ id: cards[index].id, verdict, feedback });
		index += 1;
	};
</script>

<div class="mx-auto max-w-xl space-y-3">
	{#if index < cards.length}
		{#key cards[index].id}
			<div in:fly={{ y: 12, duration: 200 }}>
				<ValidationCard card={cards[index]} onjudge={judge} />
			</div>
		{/key}
		<p class="text-muted-foreground text-center text-sm">{index + 1} / {cards.length}</p>
	{:else}
		<p class="text-muted-foreground py-16 text-center">All caught up — nothing left to review.</p>
	{/if}
</div>
