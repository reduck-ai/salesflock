<script lang="ts">
	// The deck: one judgment at a time, advance on each verdict. #key remounts the card per id
	// so the note field clears itself. Each verdict stamps a one-line receipt above the deck —
	// the session's scrollback of what was decided. ReviewCard stays pure, persistence stays
	// the caller's. ←/→ navigate without deciding.
	import { fly } from "svelte/transition";
	import ReviewCard from "./ReviewCard.svelte";
	import type { EvidencedJudgment, Judgment, Statement, Verdict } from "./types";

	let { judgments, onjudge }: { judgments: EvidencedJudgment[]; onjudge?: (j: Judgment) => void } = $props();

	let index = $state(0);
	let receipts = $state<{ verdict: Verdict; title: string; href?: string }[]>([]);
	let card = $state<ReviewCard>();

	const judge = (verdict: Verdict | undefined, feedback: string, cta?: string, reasoning?: Statement[]) => {
		const j = judgments[index];
		onjudge?.({ id: j.id, verdict, feedback, cta, reasoning });
		// a Save (no verdict) persists the edits but leaves the deck put — receipts are for
		// decided cards, and the row is still under review.
		if (verdict) {
			receipts.push({ verdict, title: j.title, href: j.href });
			index += 1;
		}
	};
	const nav = (dir: -1 | 1) => (index = Math.min(judgments.length - 1, Math.max(0, index + dir)));

	// Save the current card's draft — the page's Save icon + ⌘S call this. Returns whether
	// there was a card to save (false when caught up), so the page flashes only on a real save.
	export function save(): boolean {
		if (!card) return false;
		card.save();
		return true;
	}
</script>

{#if receipts.length}
	<div class="mb-4 space-y-1">
		{#each receipts as r, i (i)}
			<a
				class="text-muted-foreground hover:text-foreground flex items-baseline gap-2 font-mono text-xs"
				href={r.href}
				target="_blank"
				rel="noopener"
				in:fly={{ y: -6, duration: 200 }}
			>
				<span class={r.verdict === "accepted" ? "text-green-600" : "text-red-600"}>
					{r.verdict === "accepted" ? "✓ Accepted" : "✕ Rejected"}
				</span>
				<span class="truncate">{r.title}</span>
			</a>
		{/each}
	</div>
{/if}

{#if index < judgments.length}
	{#key judgments[index].id}
		<div in:fly={{ y: 12, duration: 200 }}>
			<ReviewCard
				bind:this={card}
				judgment={judgments[index]}
				pos={index + 1}
				total={judgments.length}
				onjudge={judge}
				onnav={nav}
			/>
		</div>
	{/key}
{:else}
	<p class="text-muted-foreground py-24 text-center">All caught up — nothing left to review.</p>
{/if}
