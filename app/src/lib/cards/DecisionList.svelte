<script lang="ts">
	// The home: the review working set as a list. The filter bar builds a Filter; every change
	// rewrites the URL query (the set's one description), re-running the load. Each row links to
	// /<id>?{filter} — the deck opens scoped to this exact set, so prev/next and "back" line up.
	import { goto } from "$app/navigation";
	import { filterQuery, type Filter, type Tab, type Feedback, type Sort } from "$lib/filter";
	import type { DecisionRow } from "./decision";

	let { rows, prompts, filter }: { rows: DecisionRow[]; prompts: string[]; filter: Filter } = $props();

	const dashless = (id: string) => id.replace(/-/g, "");

	// a filter change → the new query on `/`, replacing history (a filter is a view, not a step).
	const apply = (patch: Partial<Filter>) => {
		const next = { ...filter, ...patch };
		goto(`/${filterQuery(next)}`, { replaceState: true, keepFocus: true, noScroll: true });
	};

	const ago = (iso: string): string => {
		const h = (Date.now() - new Date(iso).getTime()) / 36e5;
		if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
		if (h < 24) return `${Math.round(h)}h ago`;
		const d = Math.round(h / 24);
		return d === 1 ? "yesterday" : `${d}d ago`;
	};
</script>

<div class="filters">
	<div class="seg">
		{#each [["review", "To review"], ["past", "Past"]] as [v, l] (v)}
			<button class:on={filter.tab === v} onclick={() => apply({ tab: v as Tab })}>{l}</button>
		{/each}
	</div>

	<label class="field">
		Prompt
		<select value={filter.prompt} onchange={(e) => apply({ prompt: e.currentTarget.value })}>
			<option value="all">All</option>
			{#each prompts as p (p)}<option value={p}>{p}</option>{/each}
		</select>
	</label>

	<label class="field">
		Feedback
		<select value={filter.feedback} onchange={(e) => apply({ feedback: e.currentTarget.value as Feedback })}>
			<option value="any">Any</option>
			<option value="has">Has feedback</option>
			<option value="none">No feedback</option>
		</select>
	</label>

	<label class="field">
		Sort
		<select value={filter.sort} onchange={(e) => apply({ sort: e.currentTarget.value as Sort })}>
			<option value="date">Date</option>
			<option value="prompt">Prompt</option>
		</select>
	</label>

	<span class="count">{rows.length} {filter.tab === "review" ? "to review" : "past"}</span>
</div>

<div class="list" data-sveltekit-preload-data="hover">
	{#each rows as r (r.id)}
		<a class="row" href={`/${dashless(r.id)}${filterQuery(filter)}`}>
			<span class="name">{r.name}</span>
			<span class="meta"><span class="kind">{r.kind || "—"}</span> · {ago(r.date)}</span>
			<span class="right">
				{#if r.verdict}
					<span class="agree" class:ok={r.verdict === "Accepted"} class:edit={r.verdict === "Rejected"}>
						{r.verdict === "Accepted" ? "✓ Confirmed" : "✎ Edited"}
					</span>
				{/if}
				{#if r.hasFeedback}<span class="fb" title="Has feedback">💬</span>{/if}
				{#if r.kind}<span class="badge">{r.kind}</span>{/if}
			</span>
		</a>
	{:else}
		<p class="empty">Nothing here — try another filter.</p>
	{/each}
</div>

<style>
	.filters {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.7rem;
		padding: 0.3rem 0 1rem;
		border-bottom: 1px solid var(--border);
	}
	.seg {
		display: inline-flex;
		background: var(--secondary);
		border-radius: 9px;
		padding: 3px;
	}
	.seg button {
		border: none;
		background: transparent;
		color: var(--muted-foreground);
		font: inherit;
		font-size: 0.82rem;
		padding: 0.32rem 0.7rem;
		border-radius: 7px;
		cursor: pointer;
	}
	.seg button.on {
		background: var(--card);
		color: var(--foreground);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
		font-weight: 550;
	}
	.field {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}
	select {
		font: inherit;
		font-size: 0.82rem;
		color: var(--foreground);
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.34rem 0.5rem;
	}
	.count {
		margin-left: auto;
		font-size: 0.8rem;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}

	.list {
		padding: 0.5rem 0 1rem;
	}
	.row {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.15rem 0.8rem;
		align-items: center;
		padding: 0.8rem;
		border-radius: 10px;
		text-decoration: none;
		color: inherit;
	}
	.row:hover {
		background: var(--secondary);
	}
	.row + .row {
		border-top: 1px solid color-mix(in oklab, var(--border) 60%, transparent);
	}
	.row:hover + .row {
		border-top-color: transparent;
	}
	.name {
		font-weight: 550;
		font-size: 0.98rem;
	}
	.meta {
		grid-column: 1;
		color: var(--muted-foreground);
		font-size: 0.8rem;
	}
	.meta .kind {
		color: var(--muted-foreground);
		opacity: 0.75;
	}
	.right {
		grid-row: 1 / span 2;
		grid-column: 2;
		display: flex;
		align-items: center;
		gap: 0.7rem;
		justify-self: end;
	}
	.badge {
		font-size: 0.72rem;
		color: var(--muted-foreground);
		background: var(--secondary);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0.18rem 0.6rem;
		white-space: nowrap;
	}
	.fb {
		font-size: 0.85rem;
	}
	.agree {
		font-size: 0.78rem;
		font-weight: 600;
		white-space: nowrap;
	}
	.agree.ok {
		color: #16a34a;
	}
	.agree.edit {
		color: #b7791f;
	}
	.empty {
		text-align: center;
		color: var(--muted-foreground);
		padding: 4rem 1rem;
	}
</style>
