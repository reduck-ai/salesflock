<script lang="ts">
	import { fly } from "svelte/transition";
	import { goto, invalidate, preloadData } from "$app/navigation";
	import { page, navigating } from "$app/state";
	import { browser } from "$app/environment";
	import { Button } from "$lib/components/ui/button/index.js";
	import DecisionList from "$lib/cards/DecisionList.svelte";
	import ReviewCard from "$lib/cards/ReviewCard.svelte";
	import CardSkeleton from "$lib/cards/CardSkeleton.svelte";
	import Toaster from "$lib/cards/Toaster.svelte";
	import { toast, settle, inFlight } from "$lib/cards/toast.svelte";
	import { dropCard } from "$lib/cards/cache";
	import { filterQuery } from "$lib/filter";
	import type { Judgment } from "$lib/cards/types";

	let { data } = $props();

	let card = $state<ReviewCard>();
	let menuOpen = $state(false);
	let userEl = $state<HTMLElement>();

	// theme — app-wide chrome (core owns it). The no-flash boot script in app.html applies the saved
	// choice before paint; this just flips the root `.dark` class and persists it. Default dark.
	let dark = $state(browser ? document.documentElement.classList.contains("dark") : true);
	const setTheme = (d: boolean) => {
		dark = d;
		document.documentElement.classList.toggle("dark", d);
		localStorage.theme = d ? "dark" : "light";
	};

	const dashless = (id: string) => id.replace(/-/g, "");

	// The runs still in flight — the queue, read straight off the toast stack (there is no second
	// structure; see toast.svelte.ts). Two readings, one bit: the appbar's count, and the set of
	// rows the rail must not show yet. `pending` means precisely "the rail does not reflect this
	// decision", so the hide-list IS the queue and the two can never disagree.
	const posting = $derived(inFlight());
	const hidden = $derived(new Set(posting.map((t) => t.id)));

	// the URL is the cursor: `page.params.id` is the current card, `rows` (the layout's per-filter
	// rail, minus whatever is still posting) its neighbours. A card outside the set → index -1 (no
	// neighbours). Hiding here is what makes a Confirm advance instantly: the decided row leaves the
	// rail at the click, exactly as it used to leave it after the write landed — same slot, same
	// successor, no round-trip. It comes back by itself if the commit fails.
	const rows = $derived(data.rows.filter((r) => !hidden.has(dashless(r.id))));
	const currentId = $derived(page.params.id ?? null);
	const index = $derived(currentId ? rows.findIndex((r) => dashless(r.id) === dashless(currentId)) : -1);
	const href = (i: number) => (rows[i] ? `/${dashless(rows[i].id)}${filterQuery(data.filter)}` : undefined);
	const prev = $derived(index > 0 ? href(index - 1) : undefined);
	const next = $derived(index >= 0 ? href(index + 1) : undefined);

	// the one slow op is loading a card, so the slot shows a skeleton until the card is the one the
	// URL names — a fact of the DATA, never of the router's in-flight status. Deriving this from
	// `navigating` latched it: a superseded navigation leaves `navigating.to` set, and the flag never
	// cleared. Compared against data it self-heals — the instant data.current matches, the card renders.
	const stale = $derived(dashless(data.current?.id ?? "") !== dashless(currentId ?? ""));

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

	// Persist a judgment. A Save awaits it (you are still on the card, still editing it); a COMMIT
	// does not — it advances the deck at once and lets the request settle its own queue entry.
	//
	// The reason that is safe is that only the UI stops waiting. The request stays one atomic act:
	// `record` gates, performs the agent's `act` (a browser run — tens of seconds), and only then
	// writes, so a failure persists nothing and leaves the row exactly where it was. The window this
	// design forbids is a PERSISTED one — a row marked approved that something else must later
	// notice and finish — and there is still none. What used to be an awaited promise is now a
	// pending toast: the same in-memory fact, no longer holding the reviewer.
	//
	// Advancing is unchanged in meaning, only in timing. The rail's chain-keyed order IS the
	// sequencing: the decided row leaves the set and a dependent it unblocked surfaces at the very
	// slot its gate held (a rejected gate's dependent is archived server-side and never appears). It
	// leaves the set at the CLICK now (it has a pending toast) rather than after the write, so the
	// step is the same one uniform move — open whatever row now sits at this index.
	const judge = async ({ output, feedback, reasoning, commit }: Omit<Judgment, "id">) => {
		if (!data.current) return;
		const j = data.current;
		const id = dashless(j.id); // the route param, the toast key, and the queue's handle: one id
		// A second Confirm before the navigation lands would mint a twin. The guard is the queue
		// itself — no separate in-flight flag to keep in step with it.
		if (commit && hidden.has(id)) return;
		const at = index; // the slot the successor shifts into
		const back = `/${id}${filterQuery(data.filter)}`; // captured now: `data` moves under us
		const post = fetch("/api/decide", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: j.id,
				output,
				feedback,
				finalReasoning: reasoning ? JSON.stringify(reasoning) : undefined,
				commit
			})
		}).catch(() => undefined);
		dropCard(j.id); // the card was written to — a re-view must refetch the persisted state
		const reason = async (res?: Response) =>
			((await res?.json().catch(() => ({}))) as { message?: string } | undefined)?.message;

		// A Save keeps the card and the row's place, so there is nothing to advance to and nothing to
		// queue: it is a Notion write, hundreds of milliseconds, and the reviewer is looking at it.
		if (!commit) {
			const res = await post;
			return void toast(
				res?.ok ? { message: "Saved", tone: "ok" } : { message: (await reason(res)) ?? "Not saved", tone: "error" }
			);
		}

		// The queue entry — the receipt, minted before the fact and keyed on the decision. Pushing it
		// is what removes the row from `rows`, so the deck can move on the very next line.
		toast({ message: "Posting…", detail: j.title, tone: "ok", pending: true }, id);
		goto(href(Math.min(at, rows.length - 1)) ?? `/${filterQuery(data.filter)}`);

		// …and whenever the run lands, it resolves that same entry in place. "Edited" is measured
		// against the JUDGE's proposal, never against what the card opened on — reopening a row seeds
		// from the human's own latest word, so comparing with that would call every overturn a plain
		// confirmation the moment it was saved once. Computed here, before `j` goes stale.
		const edited = JSON.stringify(output) !== JSON.stringify(j.proposed);
		void post.then(async (res) => {
			// A refused write (a dependent whose upstream isn't approved, a device asleep, a subreddit
			// that rejected the comment) must be SEEN, not swallowed — and by now the reviewer is two
			// cards further on, so the toast carries the reason and a way back to the live card. The
			// row returns to the rail by itself: clearing `pending` un-hides it, and nothing was written.
			if (!res?.ok)
				return settle(id, {
					message: (await reason(res)) ?? "Not saved",
					detail: j.title,
					href: back,
					tone: "error"
				});
			// Settle only AFTER the rail is refreshed, so the row is gone from `data.rows` before it
			// stops being hidden — one lifetime for `pending`, and no frame where the decided row
			// flashes back into the deck.
			await invalidate("app:rail");
			settle(id, {
				message: edited ? "Edited" : "Confirmed",
				tone: edited ? "edit" : "ok",
				detail: j.title,
				href: j.href
			});
		});
	};

	const save = () => card?.save();

	// The page-level chords: ⌘S saves, ⌘E toggles the note, ⌘⏎ confirms — all here (not in the card)
	// so they fire even while typing a note, and no bare key commits. Bound declaratively on
	// <svelte:window>, so there is no listener to attach, tear down, or leak.
	const hotkey = (e: KeyboardEvent) => {
		if (!data.user || !currentId || !(e.metaKey || e.ctrlKey)) return;
		if (e.key === "s") (e.preventDefault(), save());
		else if (e.key === "e") (e.preventDefault(), card?.note());
		else if (e.key === "Enter") (e.preventDefault(), card?.confirm());
	};
</script>

<!-- The one thing a volatile queue must guard: leaving while a run is in flight loses its entry (the
     write has not landed, so the row still reads unconfirmed). Nothing is corrupted either way —
     the act no-ops on its own recorded effect, so a re-confirm cannot repeat it — but a browser
     asking first beats a reviewer wondering later. -->
<svelte:window
	onclick={(e) => menuOpen && !userEl?.contains(e.target as Node) && (menuOpen = false)}
	onkeydown={hotkey}
	onbeforeunload={(e) => posting.length && e.preventDefault()}
/>

<Toaster />

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
				<!-- the queue's headline, and the only always-visible one: how many replies are still
				     posting. Present only while there are any — a zero would be chrome. The stack
				     top-right is the same fact itemized, so this needs no click of its own. -->
				{#if posting.length}
					<span class="pill" title={posting.map((t) => t.detail).join("\n")}>
						<svg class="spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.22-8.56" /></svg>
						{posting.length} posting
					</span>
				{/if}
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
							<div class="seg" role="group" aria-label="Theme">
								<button class:on={dark} aria-pressed={dark} onclick={() => setTheme(true)}>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg>
									Dark
								</button>
								<button class:on={!dark} aria-pressed={!dark} onclick={() => setTheme(false)}>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></svg>
									Light
								</button>
							</div>
							<form method="POST" action="?/signout">
								<button type="submit" class="item">Log out</button>
							</form>
						</div>
					{/if}
				</div>
			</div>
		</header>

		{#if !currentId}
			<DecisionList {rows} prompts={data.prompts} filter={data.filter} />
		{:else}
			{#if !data.current || stale}
				<CardSkeleton />
			{:else}
				{#key data.current.id}
					<div in:fly={{ y: 12, duration: 200 }}>
						<ReviewCard
							bind:this={card}
							judgment={data.current}
							pos={index >= 0 ? index + 1 : undefined}
							total={rows.length || 1}
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
	/* the run counter — the same muted register as the toolbar buttons it sits beside, so a busy
	   queue reads as status rather than as an alert. It appears and disappears with the work. */
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		align-self: center;
		margin-right: 6px;
		padding: 4px 9px;
		border-radius: 999px;
		background: var(--secondary);
		color: var(--muted-foreground);
		font-size: 12px;
		font-weight: 550;
		white-space: nowrap;
	}
	.spin {
		animation: spin 900ms linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spin {
			animation: none;
		}
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
	.item {
		display: flex;
		align-items: center;
		gap: 8px;
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
	.item:hover {
		background: var(--accent);
	}
	/* the theme toggle — a two-state pill, the same segmented language as the filter bar */
	.seg {
		display: flex;
		gap: 4px;
		margin: 8px;
		padding: 3px;
		background: var(--secondary);
		border-radius: 9px;
	}
	.seg button {
		flex: 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border: none;
		background: transparent;
		color: var(--muted-foreground);
		font: inherit;
		font-size: 12.5px;
		padding: 5px 8px;
		border-radius: 7px;
		cursor: pointer;
	}
	.seg button.on {
		background: var(--card);
		color: var(--foreground);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.15);
		font-weight: 550;
	}
</style>
