<script lang="ts">
	// The OUTPUT zone — the agent's proposal rendered from its Prompt Output schema, editable in
	// place. The committed value IS the decision. The schema alone decides what's editable: a field
	// is the human's unless it is `readOnly` or pinned to a `const`. Read-only scalars show as
	// context (a URL as a link); read-only arrays/objects (anchoring metadata like `quotes`) are
	// omitted — they live as highlights in the evidence. No field names in here; the contract
	// governs. Enforcement is the caller's (ReviewCard runs the shared `schemaError` gate). A
	// self-contained render seam — swap for a schema-form library without touching the dock. Deep
	// $state makes nested mutation reactive; no effects, no bind gymnastics.
	type Schema = {
		properties?: Record<string, Schema>;
		anyOf?: Schema[];
		format?: string;
		enum?: unknown[];
		const?: unknown;
		readOnly?: boolean;
	};
	let { schema, value = $bindable() }: { schema?: Schema; value: Record<string, unknown> } = $props();

	const label = (k: string) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
	// the human's to edit unless the schema pins it to one value: readOnly, a const, or a
	// single-option enum (a discriminator like `action`)
	const fixed = (p?: Schema) =>
		!!p?.readOnly || p?.const !== undefined || (Array.isArray(p?.enum) && p.enum.length === 1);
	const editable = (p?: Schema) => !fixed(p);
	const isUrl = (p: Schema | undefined, v: unknown) =>
		p?.format === "uri" || (typeof v === "string" && /^https?:\/\//.test(v));
	// resolve a discriminated union to the branch matching the value (by const / single-enum), so
	// readOnly markers inside a branch are reachable; a plain object schema passes through.
	const branch = (p: Schema | undefined, v: Record<string, unknown>): Schema | undefined => {
		if (!p?.anyOf) return p;
		return (
			p.anyOf.find((b) =>
				Object.entries(b.properties ?? {}).every(([k, s]) => {
					const fixed = s.const ?? (s.enum?.length === 1 ? s.enum[0] : undefined);
					return fixed === undefined || fixed === v?.[k];
				})
			) ?? p
		);
	};
	const propOf = (p: Schema | undefined, k: string): Schema | undefined => p?.properties?.[k];
</script>

{#snippet field(obj: Record<string, unknown>, key: string, prop: Schema | undefined)}
	{@const v = obj[key]}
	{#if !editable(prop)}
		{#if v !== null && typeof v === "object"}
			<!-- read-only array/object (e.g. quotes) — not shown; it lives in the evidence -->
		{:else}
			<div class="row">
				<span class="lbl">{label(key)}</span>
				{#if isUrl(prop, v)}
					<a class="link" href={String(v)} target="_blank" rel="noopener">{v}</a>
				{:else}
					<span class="ro">{v}</span>
				{/if}
			</div>
		{/if}
	{:else if Array.isArray(prop?.enum)}
		<div class="row">
			<span class="lbl">{label(key)}</span>
			<div class="seg">
				{#each prop?.enum ?? [] as opt (opt)}
					<button type="button" class="opt" class:on={v === opt} onclick={() => (obj[key] = opt)}>
						{opt}
					</button>
				{/each}
			</div>
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
		{@const s = branch(prop, v as Record<string, unknown>)}
		<fieldset class="grp">
			<legend>{label(key)}</legend>
			{#each Object.keys(v) as k (k)}
				{@render field(v as Record<string, unknown>, k, propOf(s, k))}
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
	/* a read-only scalar — context, not an input */
	.ro {
		color: var(--foreground);
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
