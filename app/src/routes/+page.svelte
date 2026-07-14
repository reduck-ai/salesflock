<script lang="ts">
	import { Button } from "$lib/components/ui/button/index.js";
	import JudgmentStack from "$lib/cards/JudgmentStack.svelte";
	import type { Judgment } from "$lib/cards/types";

	let { data } = $props();

	// Persist each verdict + feedback to its source record; fire-and-forget so the
	// deck keeps its snappy feel. A failure surfaces in the console, not a blocked UI.
	const judge = (j: Judgment) =>
		fetch("/api/decide", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(j)
		}).catch((e) => console.error("decide failed", e));
</script>

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
	<main class="mx-auto max-w-3xl space-y-5 p-6">
		<header class="flex items-center justify-between">
			<h1 class="text-2xl font-semibold">Decisions</h1>
			<form method="POST" action="?/signout">
				<Button type="submit" variant="ghost">{data.user.name} · Sign out</Button>
			</form>
		</header>

		<JudgmentStack judgments={data.judgments} onjudge={judge} />
	</main>
{/if}
