<script lang="ts">
	// The deck. Renders the top card plus two behind it, holds the optional feedback
	// that rides along with the next verdict, and advances after each decision. The
	// only stateful piece; ValidationCard stays pure. Emits a Judgment per card and
	// leaves persistence to the caller.
	import ValidationCard from "./ValidationCard.svelte";
	import type { CardModel, Judgment, Verdict } from "./types";

	let { cards, onjudge }: { cards: CardModel[]; onjudge?: (j: Judgment) => void } = $props();

	let index = $state(0);
	let feedback = $state("");
	let busy = $state(false); // one decision at a time, while the top card flies off

	// Top + the next two, so the stack reads as a deck. Keyed by id downstream.
	const visible = $derived(cards.slice(index, index + 3));

	const judge = (verdict: Verdict) => {
		if (busy) return;
		busy = true;
		onjudge?.({ id: cards[index].id, verdict, feedback: feedback.trim() });
		feedback = "";
		// Let the fly-off (300ms) finish before the card unmounts and the deck slides up.
		setTimeout(() => {
			index += 1;
			busy = false;
		}, 300);
	};
</script>

{#if index < cards.length}
	<div class="mx-auto flex max-w-xl flex-col gap-4">
		<textarea
			bind:value={feedback}
			rows="2"
			placeholder="Optional feedback — sent with your next decision…"
			class="border-input bg-background focus-visible:ring-ring resize-none rounded-md border px-3 py-2 text-sm focus-visible:ring-1 focus-visible:outline-none"
		></textarea>

		<div class="relative h-96">
			{#each visible as card, i (card.id)}
				<ValidationCard {card} depth={i} interactive={i === 0} ondecide={judge} />
			{/each}
		</div>
	</div>
{:else}
	<p class="text-muted-foreground py-16 text-center">All caught up — nothing left to review.</p>
{/if}
