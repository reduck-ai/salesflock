<script lang="ts">
	// The deck: one judgment at a time, advance on each verdict. #key remounts the card per id
	// so the note field clears itself. Each verdict stamps a one-line receipt above the deck —
	// the session's scrollback of what was decided. ReviewCard stays pure, persistence stays
	// the caller's. ←/→ navigate without deciding.
	import { fly } from "svelte/transition";
	import ReviewCard from "./ReviewCard.svelte";
	import Toast from "./Toast.svelte";
	import type { EvidencedJudgment, Judgment, Statement } from "./types";

	let {
		judgments,
		onjudge,
		start,
		oncurrent
	}: {
		judgments: EvidencedJudgment[];
		onjudge?: (j: Judgment) => void;
		start?: string | null; // the id (dashless) to open on — the URL's decision
		oncurrent?: (id: string) => void; // the front card's id (dashless), on mount and each advance
	} = $props();

	const bare = (id: string) => id.replace(/-/g, "");
	// open on the URL's decision when it's in the deck, else the top
	let index = $state(Math.max(0, start ? judgments.findIndex((j) => bare(j.id) === start) : 0));
	// a decided card's receipt: `edited` means the human overturned the agent's output (the
	// committed output differs), else they confirmed it verbatim.
	let receipts = $state<{ edited: boolean; title: string; href?: string }[]>([]);
	let card = $state<ReviewCard>();
	// the transient toast — both actions converge here, so this is its one trigger. Keyed by a
	// monotonic id so a rapid re-fire remounts (restarting its bar); the count stays the rail's job.
	let toast = $state<{ id: number; message: string } | null>(null);
	let seq = 0;

	// keep the URL naming the on-screen decision, on each advance. Skip the first run: the URL
	// already names the start card (the server redirect / the deep link), and replaceState throws
	// if called during hydration, before the router is initialized.
	let synced = false;
	$effect(() => {
		const j = judgments[index];
		if (synced && j) oncurrent?.(bare(j.id));
		synced = true;
	});

	const judge = (
		committedOutput: Record<string, unknown> | undefined,
		feedback: string,
		reasoning?: Statement[]
	) => {
		const j = judgments[index];
		onjudge?.({ id: j.id, committedOutput, feedback, reasoning });
		// a Save (no committed output) persists the edits but leaves the deck put — receipts are
		// for decided cards, and the row is still under review. Either way, one toast.
		if (committedOutput) {
			receipts.push({
				edited: JSON.stringify(committedOutput) !== JSON.stringify(j.output),
				title: j.title,
				href: j.href
			});
			index += 1;
			toast = { id: ++seq, message: "Confirmed" };
		} else {
			toast = { id: ++seq, message: "Saved" };
		}
	};
	const nav = (dir: -1 | 1) => (index = Math.min(judgments.length - 1, Math.max(0, index + dir)));

	// Save the current card's draft — the page's Save icon + ⌘S call this. No-ops when caught up
	// (no card), so the "Saved" toast fires only on a real save.
	export function save(): void {
		card?.save();
	}

	// Confirm the front card — the twin of save(), routing the page's ⌘⏎ chord to the deck.
	export function confirm(): void {
		card?.confirm();
	}

	// Toggle the front card's note field — routing the page's ⌘E chord to the deck.
	export function note(): void {
		card?.note();
	}
</script>

{#if toast}
	{#key toast.id}
		<Toast message={toast.message} ondone={() => (toast = null)} />
	{/key}
{/if}

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
				<span class={r.edited ? "text-amber-600" : "text-green-600"}>
					{r.edited ? "✎ Edited" : "✓ Confirmed"}
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
