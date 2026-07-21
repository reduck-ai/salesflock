<script lang="ts">
	import { replaceState } from "$app/navigation";
	import { Button } from "$lib/components/ui/button/index.js";
	import JudgmentStack from "$lib/cards/JudgmentStack.svelte";
	import type { Judgment } from "$lib/cards/types";

	let { data } = $props();

	let stack = $state<JudgmentStack>();
	let menuOpen = $state(false);
	let userEl = $state<HTMLElement>();

	// Persist a judgment to its source record; fire-and-forget so the deck keeps its snappy feel.
	// A judgment with no `committedOutput` is a Save — the write skips the decision + pipeline
	// move server-side. Otherwise the committed output IS the decision and travels as-is (its
	// schema is the Prompt's). Edited statements travel as finalReasoning.
	const judge = (j: Judgment) => {
		// store the human's reasoning as-is: quotes are already [start,end) ranges into the
		// evidence (a human quote carries no intended_text — the position IS the span).
		const finalReasoning = j.reasoning ? JSON.stringify(j.reasoning) : undefined;
		fetch("/api/decide", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: j.id,
				committedOutput: j.committedOutput,
				feedback: j.feedback,
				finalReasoning
			})
		}).catch((e) => console.error("decide failed", e));
	};

	// Save the current card's draft — the deck fires the "Saved" toast, so no header flash here.
	const save = () => stack?.save();

	// The page-level chords: ⌘S saves, ⌘E toggles the note field, ⌘⏎ confirms the front card. All
	// live here (not in the card) so they fire even while typing a note, and no bare key commits —
	// a stray ⏎ is inert. The card's own handler owns only navigation (←/→, Tab, ⌫), ignored inside inputs.
	$effect(() => {
		if (!data.user) return;
		const onkey = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey)) return;
			if (e.key === "s") {
				e.preventDefault();
				save();
			} else if (e.key === "e") {
				e.preventDefault();
				stack?.note();
			} else if (e.key === "Enter") {
				e.preventDefault();
				stack?.confirm();
			}
		};
		window.addEventListener("keydown", onkey);
		return () => window.removeEventListener("keydown", onkey);
	});
</script>

<!-- click anywhere outside the account menu closes it (the pattern ReviewCard uses) -->
<svelte:window onclick={(e) => menuOpen && !userEl?.contains(e.target as Node) && (menuOpen = false)} />

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
			<h1 class="text-2xl font-semibold">Decisions</h1>
			<div class="toolbar">
				<button class="tbtn" onclick={save} title="Save (⌘S)" aria-label="Save">
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						><path
							d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"
						/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" /><path d="M7 3v4a1 1 0 0 0 1 1h7" /></svg
					>
				</button>

				<div class="user" bind:this={userEl}>
					<button
						class="tbtn"
						class:on={menuOpen}
						onclick={() => (menuOpen = !menuOpen)}
						title="Account"
						aria-label="Account"
						aria-expanded={menuOpen}
					>
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
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

		<!-- the deck starts at the URL's decision and rewrites the URL to whichever it advances to,
		     so the address bar always names the on-screen decision (copy → paste → jump back here) -->
		<JudgmentStack
			bind:this={stack}
			judgments={data.judgments}
			start={data.currentId}
			oncurrent={(id) => replaceState(`/${id}`, {})}
			onjudge={judge}
		/>
	</main>
{/if}

<style>
	/* the app header — the top of the always-visible bar: sticks to the viewport, the card's
	   progress/hints stick flush beneath it (top: var(--topbar)). Opaque, so evidence scrolls under. */
	.appbar {
		position: sticky;
		top: 0;
		z-index: 20;
		height: var(--topbar);
		background: var(--background);
	}
	/* the toolbar — Save + account, right-aligned in the header, level with the title */
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
	.tbtn:hover {
		color: var(--foreground);
		background: var(--accent);
	}
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
