<script lang="ts">
	// The deck: one judgment at a time, advance on each verdict. #key remounts the card per id
	// so the slide-in reads as "next one" and the note field clears itself. All the state there
	// is; ReviewCard stays pure, persistence stays the caller's. ←/→ navigate without deciding.
	import { fly } from "svelte/transition";
	import ReviewCard from "./ReviewCard.svelte";
	import type { EvidencedJudgment, Judgment, Verdict } from "./types";

	let { judgments, onjudge }: { judgments: EvidencedJudgment[]; onjudge?: (j: Judgment) => void } = $props();

	let index = $state(0);

	const judge = (verdict: Verdict, feedback: string) => {
		onjudge?.({ id: judgments[index].id, verdict, feedback });
		index += 1;
	};
	const nav = (dir: -1 | 1) => (index = Math.min(judgments.length - 1, Math.max(0, index + dir)));
</script>

{#if index < judgments.length}
	{#key judgments[index].id}
		<div in:fly={{ y: 12, duration: 200 }}>
			<ReviewCard
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
