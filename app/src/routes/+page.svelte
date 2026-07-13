<script lang="ts">
	import { Badge } from "$lib/components/ui/badge/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import * as Card from "$lib/components/ui/card/index.js";

	let { data } = $props();

	// Fields with a dedicated slot on the card; everything else renders as a detail line.
	const shown = new Set(["Decision", "Reasoning"]);
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
	<main class="mx-auto max-w-3xl space-y-4 p-8">
		<header class="flex items-center justify-between">
			<h1 class="text-2xl font-semibold">Decisions</h1>
			<form method="POST" action="?/signout">
				<Button type="submit" variant="ghost">{data.user.name} · Sign out</Button>
			</form>
		</header>

		{#each data.decisions as d (d.id)}
			<Card.Root>
				<Card.Header>
					<Card.Title><a href={d.url} class="hover:underline">{d.title}</a></Card.Title>
					{#if d.fields.Decision}
						<Card.Action>
							<Badge variant={d.fields.Decision === "Qualified" ? "default" : "secondary"}>
								{d.fields.Decision}
							</Badge>
						</Card.Action>
					{/if}
				</Card.Header>
				<Card.Content class="space-y-2 text-sm">
					{#if d.fields.Reasoning}<p>{d.fields.Reasoning}</p>{/if}
					{#each Object.entries(d.fields).filter(([k]) => !shown.has(k)) as [k, v] (k)}
						<p class="text-muted-foreground"><span class="font-medium">{k}</span> · {v}</p>
					{/each}
				</Card.Content>
			</Card.Root>
		{:else}
			<p class="text-muted-foreground">No decisions yet.</p>
		{/each}
	</main>
{/if}
