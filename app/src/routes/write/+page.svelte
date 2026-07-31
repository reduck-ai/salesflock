<script lang="ts">
	// Screen one: choose what to write. A row is title + status + when it was last saved + the opening
	// prose — the preview is not decoration, it is the identity: a title is optional in this database,
	// so an untitled doc is recognizable only by how it starts.
	//
	// The status tabs come from the ROWS, not a hardcoded list: whatever statuses exist are the tabs,
	// so adding one in Notion needs no code here. Filtering is local (the rows are already loaded).

	let { data } = $props();

	let status = $state("All");

	const tabs = $derived([
		"All",
		...[...new Set(data.rows.map((r) => r.status).filter(Boolean))].sort((a, b) => a.localeCompare(b))
	]);
	const rows = $derived(status === "All" ? data.rows : data.rows.filter((r) => r.status === status));

	const dashless = (id: string) => id.replace(/-/g, "");
	const when = (iso: string) =>
		new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
</script>

<svelte:head><title>Write</title></svelte:head>

<main class="mx-auto max-w-3xl px-6 pb-16">
	<header class="appbar">
		<h1 class="text-2xl font-semibold">Articles</h1>
		<form method="POST" action="?/new">
			<button class="new" type="submit">Write</button>
		</form>
	</header>

	{#if !data.user}
		<p class="empty">Sign in on the <a href="/">Decisions</a> page first.</p>
	{:else}
		<nav class="tabs" aria-label="Status">
			{#each tabs as t (t)}
				<button class="tab" class:on={status === t} aria-pressed={status === t} onclick={() => (status = t)}>
					{t}
				</button>
			{/each}
		</nav>

		{#if !rows.length}
			<p class="empty">Nothing here yet. <strong>Write</strong> starts a new one.</p>
		{:else}
			<ul class="list">
				{#each rows as r (r.id)}
					<li>
						<a class="row" href={`/write/${dashless(r.id)}`}>
							<div class="meta">
								{#if r.status}<span class="badge">{r.status}</span>{/if}
								<span>Last saved <strong>{when(r.edited)}</strong></span>
							</div>
							<div class="title" class:untitled={!r.title}>{r.title || "(Needs title)"}</div>
							{#if r.preview}<p class="preview">{r.preview}</p>{/if}
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</main>

<style>
	.appbar {
		position: sticky;
		top: 0;
		z-index: 20;
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: var(--topbar);
		background: var(--background);
	}
	.new {
		border: none;
		border-radius: 999px;
		background: var(--primary);
		color: var(--primary-foreground);
		font: inherit;
		font-size: 13px;
		font-weight: 550;
		padding: 7px 18px;
		cursor: pointer;
	}
	.new:hover {
		opacity: 0.9;
	}
	.tabs {
		display: flex;
		gap: 4px;
		padding: 3px;
		margin-bottom: 14px;
		background: var(--secondary);
		border-radius: 9px;
	}
	.tab {
		border: none;
		background: transparent;
		color: var(--muted-foreground);
		font: inherit;
		font-size: 12.5px;
		padding: 5px 12px;
		border-radius: 7px;
		cursor: pointer;
	}
	.tab.on {
		background: var(--card);
		color: var(--foreground);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.15);
		font-weight: 550;
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.row {
		display: block;
		padding: 12px 14px;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--card);
		color: inherit;
		text-decoration: none;
	}
	.row:hover {
		border-color: var(--ring);
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 11.5px;
		color: var(--muted-foreground);
	}
	.badge {
		padding: 2px 7px;
		border-radius: 6px;
		background: var(--secondary);
		color: var(--secondary-foreground);
		font-size: 10.5px;
		font-weight: 550;
	}
	.title {
		margin-top: 6px;
		font-size: 15px;
		font-weight: 600;
	}
	.title.untitled {
		color: var(--muted-foreground);
		font-weight: 500;
	}
	.preview {
		margin: 4px 0 0;
		font-size: 13px;
		line-height: 1.5;
		color: var(--muted-foreground);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.empty {
		color: var(--muted-foreground);
		font-size: 14px;
	}
</style>
