<script lang="ts">
	import { Button } from "$lib/components/ui/button/index.js";
	import JudgmentStack from "$lib/cards/JudgmentStack.svelte";
	import { correct } from "$lib/cards/decision";
	import type { Judgment } from "$lib/cards/types";

	let { data } = $props();

	// Persist each verdict + feedback to its source record; fire-and-forget so the
	// deck keeps its snappy feel. A failure surfaces in the console, not a blocked UI.
	// An edited CTA is re-fused into the judge's Output (the adapter's inverse) and
	// travels as finalOutput — the output as the human accepted it, same contract.
	const judge = (j: Judgment) => {
		const output = data.judgments.find((x) => x.id === j.id)?.output;
		const finalOutput = j.cta && output ? JSON.stringify(correct(output, j.cta)) : undefined;
		fetch("/api/decide", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: j.id, verdict: j.verdict, feedback: j.feedback, finalOutput })
		}).catch((e) => console.error("decide failed", e));
	};
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
	<main class="mx-auto max-w-3xl space-y-5 p-6 lg:flex lg:h-dvh lg:max-w-6xl lg:flex-col lg:overflow-hidden">
		<header class="flex items-center justify-between">
			<h1 class="text-2xl font-semibold">Decisions</h1>
			<form method="POST" action="?/signout">
				<Button type="submit" variant="ghost">{data.user.name} · Sign out</Button>
			</form>
		</header>

		<JudgmentStack judgments={data.judgments} onjudge={judge} />
	</main>
{/if}
