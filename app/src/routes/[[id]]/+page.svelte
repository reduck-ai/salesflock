<script lang="ts">
	import { fly } from "svelte/transition";
	import { goto, invalidate, preloadData } from "$app/navigation";
	import { page, navigating } from "$app/state";
	import { Button } from "$lib/components/ui/button/index.js";
	import DecisionList from "$lib/cards/DecisionList.svelte";
	import ReviewCard from "$lib/cards/ReviewCard.svelte";
	import CardSkeleton from "$lib/cards/CardSkeleton.svelte";
	import Toast from "$lib/cards/Toast.svelte";
	import { session, pushReceipt, fireToast, clearToast, clearSession } from "$lib/cards/session.svelte";
	import { dropCard } from "$lib/cards/cache";
	import { filterQuery } from "$lib/filter";
	import type { Statement } from "$lib/cards/types";

	let { data } = $props();

	let card = $state<ReviewCard>();
	let menuOpen = $state(false);
	let userEl = $state<HTMLElement>();

	const dashless = (id: string) => id.replace(/-/g, "");

	// the URL is the cursor: `page.params.id` is the current card, `data.rows` (from the layout, the
	// per-filter rail) its neighbours. A card outside the filtered set → index -1 (no neighbours).
	const currentId = $derived(page.params.id ?? null);
	const index = $derived(currentId ? data.rows.findIndex((r) => dashless(r.id) === dashless(currentId)) : -1);
	const href = (i: number) => (data.rows[i] ? `/${dashless(data.rows[i].id)}${filterQuery(data.filter)}` : undefined);
	const prev = $derived(index > 0 ? href(index - 1) : undefined);
	const next = $derived(index >= 0 ? href(index + 1) : undefined);

	// the one slow op is loading a card — show a skeleton in the card slot while navigating TO a
	// different card (the rail/header persist since layout data doesn't reload). Settled state:
	// data.current is the card for this URL.
	const loadingCard = $derived(!!navigating.to?.params?.id && navigating.to.params.id !== currentId);

	// leaving the deck for the list ends the session scrollback — a fresh deck visit starts clean.
	$effect(() => {
		if (!currentId) clearSession();
	});

	const nav = (dir: -1 | 1) => {
		const to = dir === -1 ? prev : next;
		if (to) goto(to);
	};

	// ReviewCard is the whole nav surface (it shows pos/total + the ←/→ hint and owns the keys); the
	// page just turns onnav into a goto. Warm the neighbours the moment a card settles — no links to
	// hover, so preload proactively — making a step instant without any duplicated nav chrome.
	$effect(() => {
		if (navigating.to) return;
		if (next) preloadData(next);
		if (prev) preloadData(prev);
	});

	// Persist a judgment (fire-and-forget, so the deck stays snappy) then advance. No committedOutput
	// is a Save — the row stays put. Otherwise the committed output IS the decision: stamp a receipt,
	// invalidate the rail (so the decided row leaves the review set), and move to the next card — or
	// back to the list when this was the last one.
	const judge = (
		committedOutput: Record<string, unknown> | undefined,
		feedback: string,
		reasoning?: Statement[]
	) => {
		if (!data.current) return;
		const j = data.current;
		const finalReasoning = reasoning ? JSON.stringify(reasoning) : undefined;
		fetch("/api/decide", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: j.id, committedOutput, feedback, finalReasoning })
		}).catch((e) => console.error("decide failed", e));
		dropCard(j.id); // the card was written to — a re-view must refetch the persisted state

		if (!committedOutput) {
			fireToast("Saved");
			return;
		}
		pushReceipt({
			edited: JSON.stringify(committedOutput) !== JSON.stringify(j.output),
			title: j.title,
			href: j.href
		});
		fireToast("Confirmed");
		goto(next ?? `/${filterQuery(data.filter)}`);
		invalidate("app:rail"); // the decided row must drop from the review set
	};

	const save = () => card?.save();

	// The page-level chords: ⌘S saves, ⌘E toggles the note, ⌘⏎ confirms — all here (not in the card)
	// so they fire even while typing a note, and no bare key commits.
	$effect(() => {
		if (!data.user || !currentId) return;
		const onkey = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey)) return;
			if (e.key === "s") (e.preventDefault(), save());
			else if (e.key === "e") (e.preventDefault(), card?.note());
			else if (e.key === "Enter") (e.preventDefault(), card?.confirm());
		};
		window.addEventListener("keydown", onkey);
		return () => window.removeEventListener("keydown", onkey);
	});
</script>

<svelte:window onclick={(e) => menuOpen && !userEl?.contains(e.target as Node) && (menuOpen = false)} />

{#if session.toast}
	{#key session.toast.id}
		<Toast message={session.toast.message} ondone={clearToast} />
	{/key}
{/if}

{#if !data.user}
	<main class="grid min-h-svh place-items-center">
		{#if data.mode === "oauth"}
			<form method="POST" action="?/signin">
				<input type="hidden" name="providerId" value="google" />
				<Button type="submit" size="lg">Sign in with Google</Button>
			</form>
		{:else}
			<form method="POST" action="?/signin" class="flex gap-2">
				<input
					name="key"
					type="password"
					placeholder="Access key"
					class="border-input bg-background focus-visible:ring-ring rounded-md border px-3 py-2 text-sm focus-visible:ring-1 focus-visible:outline-none"
				/>
				<Button type="submit" size="lg">Enter</Button>
			</form>
		{/if}
	</main>
{:else}
	<main class="mx-auto max-w-3xl px-6 pb-6">
		<header class="appbar flex items-center justify-between">
			{#if currentId}
				<a class="back" href={`/${filterQuery(data.filter)}`}>← Decisions</a>
			{:else}
				<h1 class="text-2xl font-semibold">Decisions</h1>
			{/if}
			<div class="toolbar">
				{#if currentId}
					<button class="tbtn" onclick={save} title="Save (⌘S)" aria-label="Save">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
							><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" /><path d="M7 3v4a1 1 0 0 0 1 1h7" /></svg
						>
					</button>
				{/if}
				<div class="user" bind:this={userEl}>
					<button class="tbtn" class:on={menuOpen} onclick={() => (menuOpen = !menuOpen)} title="Account" aria-label="Account" aria-expanded={menuOpen}>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
							><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg
						>
					</button>
					{#if menuOpen}
						<div class="menu">
							<div class="who">{data.user.name}</div>
							<form method="POST" action="?/signout">
								<button type="submit" class="logout">Log out</button>
							</form>
						</div>
					{/if}
				</div>
			</div>
		</header>

		{#if !currentId}
			<DecisionList rows={data.rows} prompts={data.prompts} filter={data.filter} />
		{:else}
			{#if session.receipts.length}
				<div class="mb-4 space-y-1">
					{#each session.receipts as r, i (i)}
						<a class="text-muted-foreground hover:text-foreground flex items-baseline gap-2 font-mono text-xs" href={r.href} target="_blank" rel="noopener" in:fly={{ y: -6, duration: 200 }}>
							<span class={r.edited ? "text-amber-600" : "text-green-600"}>{r.edited ? "✎ Edited" : "✓ Confirmed"}</span>
							<span class="truncate">{r.title}</span>
						</a>
					{/each}
				</div>
			{/if}

			{#if loadingCard || !data.current}
				<CardSkeleton />
			{:else}
				{#key data.current.id}
					<div in:fly={{ y: 12, duration: 200 }}>
						<ReviewCard
							bind:this={card}
							judgment={data.current}
							pos={index >= 0 ? index + 1 : 1}
							total={data.rows.length || 1}
							onjudge={judge}
							onnav={nav}
						/>
					</div>
				{/key}
			{/if}
		{/if}
	</main>
{/if}

<style>
	.appbar {
		position: sticky;
		top: 0;
		z-index: 20;
		height: var(--topbar);
		background: var(--background);
	}
	.back {
		color: var(--muted-foreground);
		text-decoration: none;
		font-size: 1rem;
	}
	.back:hover {
		color: var(--foreground);
	}
	.toolbar {
		display: flex;
		gap: 2px;
	}
	.tbtn {
		width: 34px;
		height: 34px;
		border-radius: 10px;
		border: none;
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
		display: grid;
		place-items: center;
		transition:
			color 0.15s ease,
			background 0.15s ease;
	}
	.tbtn:hover,
	.tbtn.on {
		color: var(--foreground);
		background: var(--accent);
	}
	.user {
		position: relative;
	}
	.menu {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		z-index: 30;
		min-width: 200px;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 12px;
		box-shadow: 0 8px 30px rgb(0 0 0 / 0.16);
		overflow: hidden;
	}
	.who {
		padding: 10px 12px;
		font-size: 12.5px;
		color: var(--muted-foreground);
		border-bottom: 1px solid var(--border);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.logout {
		display: block;
		width: 100%;
		text-align: left;
		border: none;
		background: none;
		cursor: pointer;
		font: inherit;
		font-size: 13px;
		color: var(--foreground);
		padding: 9px 12px;
	}
	.logout:hover {
		background: var(--accent);
	}
</style>
