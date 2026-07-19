<script lang="ts">
	// The OUTPUT zone — the agent's proposal rendered from its Prompt Output schema, editable in
	// place. The committed value IS the decision. Minimal controls: enum → segmented, string →
	// textarea, number/boolean → input — driven by the schema (for enums) and the value (for
	// shape). Anchoring/discriminator fields (quotes, action) aren't the human's to edit; a URL
	// shows as a link. Self-contained: swap these controls for a schema-form library without
	// touching the dock. Deep $state makes nested mutation reactive — no effects, no bind gymnastics.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type Schema = { properties?: Record<string, any>; format?: string; enum?: unknown[] };
	let { schema, value = $bindable() }: { schema?: Schema; value: Record<string, unknown> } = $props();

	const label = (k: string) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
	const hidden = (k: string) => k === "quotes" || k === "action";
	const propOf = (s: Schema | undefined, k: string): Schema | undefined => s?.properties?.[k];
</script>

<!-- eslint-disable @typescript-eslint/no-explicit-any -->
{#snippet field(obj: Record<string, any>, key: string, prop: Schema | undefined)}
	{@const v = obj[key]}
	{#if hidden(key)}
		<!-- anchoring / discriminator — not editable -->
	{:else if Array.isArray(prop?.enum)}
		<div class="row">
			<span class="lbl">{label(key)}</span>
			<div class="seg">
				{#each prop.enum as opt (opt)}
					<button type="button" class="opt" class:on={v === opt} onclick={() => (obj[key] = opt)}>
						{opt}
					</button>
				{/each}
			</div>
		</div>
	{:else if key === "postUrl" || prop?.format === "uri"}
		<div class="row">
			<span class="lbl">{label(key)}</span>
			<a class="link" href={String(v)} target="_blank" rel="noopener">{v}</a>
		</div>
	{:else if typeof v === "string"}
		<label class="row">
			<span class="lbl">{label(key)}</span>
			<textarea class="txt" rows="1" value={v} oninput={(e) => (obj[key] = e.currentTarget.value)}></textarea>
		</label>
	{:else if typeof v === "number"}
		<label class="row">
			<span class="lbl">{label(key)}</span>
			<input
				class="num"
				type="number"
				value={v}
				oninput={(e) => (obj[key] = e.currentTarget.valueAsNumber)}
			/>
		</label>
	{:else if typeof v === "boolean"}
		<label class="row chk">
			<input type="checkbox" checked={v} onchange={(e) => (obj[key] = e.currentTarget.checked)} />
			<span class="lbl">{label(key)}</span>
		</label>
	{:else if v && typeof v === "object"}
		<fieldset class="grp">
			<legend>{label(key)}</legend>
			{#each Object.keys(v) as k (k)}
				{@render field(v, k, propOf(prop, k))}
			{/each}
		</fieldset>
	{/if}
{/snippet}

<div class="form">
	{#each Object.keys(value) as k (k)}
		{@render field(value, k, propOf(schema, k))}
	{/each}
</div>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 10px;
		font-size: 13px;
		line-height: 1.5;
	}
	.row {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.lbl {
		font-family: ui-monospace, monospace;
		font-size: 10.5px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted-foreground);
	}
	/* enum → segmented control; the seeded pick reads at a glance (no separate headline) */
	.seg {
		display: inline-flex;
		gap: 4px;
		flex-wrap: wrap;
	}
	.opt {
		border: 1px solid var(--input);
		background: var(--card);
		color: var(--foreground);
		cursor: pointer;
		font: inherit;
		font-size: 13px;
		font-weight: 560;
		padding: 6px 14px;
		border-radius: 9px;
		transition:
			background 0.12s ease,
			border-color 0.12s ease;
	}
	.opt:hover {
		border-color: var(--ring);
	}
	.opt.on {
		background: var(--foreground);
		color: var(--background);
		border-color: var(--foreground);
	}
	.txt {
		width: 100%;
		padding: 7px 10px;
		border: 1px solid var(--input);
		border-radius: 9px;
		background: var(--card);
		font: inherit;
		color: var(--foreground);
		resize: none;
		field-sizing: content;
	}
	.txt:focus {
		outline: none;
		border-color: var(--ring);
		box-shadow: 0 0 0 3px color-mix(in oklch, var(--ring) 30%, transparent);
	}
	.num {
		width: 120px;
		padding: 7px 10px;
		border: 1px solid var(--input);
		border-radius: 9px;
		background: var(--card);
		font: inherit;
		color: var(--foreground);
	}
	.link {
		color: var(--ring);
		text-decoration: underline;
		overflow-wrap: anywhere;
	}
	.chk {
		flex-direction: row;
		align-items: center;
		gap: 8px;
	}
	/* a nested object (e.g. the drafted next step) — its editable leaves, grouped */
	.grp {
		display: flex;
		flex-direction: column;
		gap: 8px;
		border: none;
		border-top: 1px solid var(--border);
		padding: 8px 0 0;
		margin: 0;
	}
	.grp legend {
		font-family: ui-monospace, monospace;
		font-size: 10.5px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted-foreground);
		padding: 0;
	}
</style>
