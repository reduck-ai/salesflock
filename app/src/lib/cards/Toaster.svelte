<script lang="ts">
	// The toaster — the one acknowledgment surface: a fixed top-right column of self-dismissing
	// toasts. It IS the receipt a commit used to stack above the card (verb + title + link), so a
	// decision reports itself once, out of the reading column. Props-free: it reads the module's
	// stack directly, and each toast's lifetime lives there too (see toast.svelte.ts), so a keyed
	// {#each} is the whole mechanism — every item mounts, drains and unmounts on its own schedule.
	import { fly, fade } from "svelte/transition";
	import { toasts, TOAST_MS } from "./toast.svelte";

	// The app's existing semantic pair (ReviewCard's for/against) plus the receipts' amber. One var
	// per toast drives both the glyph and the drain bar — tone is declared once, read twice.
	const TONE = { ok: "#16a34a", edit: "#d97706", error: "#dc2626" };
	// Two glyphs, not three: "Edited" is already in the message and the colour already differs, but
	// a failure under a check mark would be a lie.
	const GLYPH = { ok: "M20 6 9 17l-5-5", edit: "M20 6 9 17l-5-5", error: "M18 6 6 18M6 6l12 12" };
</script>

<div class="toaster">
	{#each toasts as t (t.id)}
		<div
			class="toast"
			role="status"
			aria-live="polite"
			style={`--tone:${TONE[t.tone]}; --dur:${TOAST_MS}ms`}
			in:fly={{ x: 16, duration: 180 }}
			out:fade={{ duration: 150 }}
		>
			<svelte:element
				this={t.href ? "a" : "div"}
				class="row"
				href={t.href}
				target={t.href ? "_blank" : undefined}
				rel={t.href ? "noopener" : undefined}
			>
				<svg
					class="glyph"
					width="15"
					height="15"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="3"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"><path d={GLYPH[t.tone]} /></svg
				>
				<span class="msg">{t.message}</span>
				{#if t.detail}<span class="detail">{t.detail}</span>{/if}
			</svelte:element>
			<div class="bar"></div>
		</div>
	{/each}
</div>

<style>
	/* the column owns the placement, so a toast itself is just a card that can be stacked */
	.toaster {
		position: fixed;
		top: calc(var(--topbar) + 12px);
		right: 16px;
		z-index: 50;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 8px;
		pointer-events: none; /* the gaps must not eat clicks on the card beneath */
	}
	.toast {
		pointer-events: auto;
		min-width: 180px;
		max-width: min(340px, calc(100vw - 32px));
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 12px;
		box-shadow: 0 8px 30px rgb(0 0 0 / 0.16);
		overflow: hidden;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 11px 14px;
		font-size: 13.5px;
		color: var(--foreground);
		text-decoration: none;
	}
	a.row:hover {
		background: var(--accent);
	}
	.glyph {
		flex: none;
		color: var(--tone);
	}
	.msg {
		flex: none;
		font-weight: 600;
	}
	.detail {
		color: var(--muted-foreground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* the continuous countdown — shrinks left-to-right over the toast's lifetime */
	.bar {
		height: 3px;
		background: var(--tone);
		transform-origin: left;
		animation: drain var(--dur) linear forwards;
	}
	@keyframes drain {
		from {
			transform: scaleX(1);
		}
		to {
			transform: scaleX(0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.bar {
			animation: none;
		}
	}
</style>
