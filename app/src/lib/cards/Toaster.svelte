<script lang="ts">
	// The toaster — the one acknowledgment surface, and the run queue with it: a fixed top-right
	// column of toasts. It IS the receipt a commit used to stack above the card (verb + title +
	// link), so a decision reports itself once, out of the reading column — and since a commit no
	// longer blocks, it is ALSO where a run still in flight lives, because the two are one object at
	// two moments of its life (see toast.svelte.ts). Props-free: it reads the module's stack
	// directly, and each toast's lifetime lives there too, so a keyed {#each} is the whole mechanism
	// — every item mounts, drains and unmounts on its own schedule. The key is the toast's id, which
	// `settle` preserves, so a run RESOLVES IN ITS SLOT rather than remounting at the bottom.
	import { fly, fade } from "svelte/transition";
	import { toasts, dismiss, TOAST_MS } from "./toast.svelte";

	// The app's existing semantic pair (ReviewCard's for/against) plus the receipts' amber. One var
	// per toast drives both the glyph and the drain bar — tone is declared once, read twice. A
	// pending toast has no verdict to colour yet, so it borrows the muted text colour.
	const TONE = { ok: "#16a34a", edit: "#d97706", error: "#dc2626" };
	// Two glyphs, not three: "Edited" is already in the message and the colour already differs, but
	// a failure under a check mark would be a lie. A third shape joins them for `pending`, and it is
	// an arc rather than a mark — the only one of the four that means "not yet".
	const GLYPH = { ok: "M20 6 9 17l-5-5", edit: "M20 6 9 17l-5-5", error: "M18 6 6 18M6 6l12 12" };
	const SPINNER = "M21 12a9 9 0 1 1-6.22-8.56";

	// An in-app href (`/id`, back to a failed card) must stay in the SPA; a Notion page must not.
	// One test on the value, so nothing has to declare which kind of link it carries.
	const external = (href?: string) => !!href?.startsWith("http");
</script>

<div class="toaster">
	{#each toasts as t (t.id)}
		<div
			class="toast"
			class:err={t.tone === "error" && !t.pending}
			role="status"
			aria-live="polite"
			style={`--tone:${t.pending ? "var(--muted-foreground)" : TONE[t.tone]}; --dur:${TOAST_MS}ms`}
			in:fly={{ x: 16, duration: 180 }}
			out:fade={{ duration: 150 }}
		>
			<svelte:element
				this={t.href ? "a" : "div"}
				class="row"
				href={t.href}
				target={external(t.href) ? "_blank" : undefined}
				rel={external(t.href) ? "noopener" : undefined}
			>
				<svg
					class="glyph"
					class:spin={t.pending}
					width="15"
					height="15"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width={t.pending ? 2.5 : 3}
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"><path d={t.pending ? SPINNER : GLYPH[t.tone]} /></svg
				>
				<span class="msg">{t.message}</span>
				{#if t.detail}<span class="detail">{t.detail}</span>{/if}
			</svelte:element>
			<!-- only a failure needs closing by hand: it is the one toast with no timer (it must
			     survive until read, since the reviewer has moved on by the time it lands). -->
			{#if t.tone === "error" && !t.pending}
				<button class="x" onclick={() => dismiss(t.id)} aria-label="Dismiss">
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
				</button>
			{/if}
			<!-- the bar says what kind of waiting this is: a sweep while the answer is unknown, a
			     drain once it is known and the toast is on its way out, and nothing at all for a
			     failure — a bar that ran to empty beside a toast that stays would be a lie. -->
			{#if t.pending}
				<div class="bar indet"></div>
			{:else if t.tone !== "error"}
				<div class="bar"></div>
			{/if}
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
		position: relative;
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
	.toast.err .row {
		padding-right: 34px; /* room for the dismiss button */
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
	.x {
		position: absolute;
		top: 8px;
		right: 8px;
		width: 20px;
		height: 20px;
		display: grid;
		place-items: center;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
	}
	.x:hover {
		background: var(--accent);
		color: var(--foreground);
	}
	/* the continuous countdown — shrinks left-to-right over the toast's lifetime */
	.bar {
		height: 3px;
		background: var(--tone);
		transform-origin: left;
		animation: drain var(--dur) linear forwards;
	}
	/* …and its indeterminate twin: the same 3px rule shuttling, because the wait has no known end */
	.bar.indet {
		animation: sweep 1.15s ease-in-out infinite;
	}
	@keyframes drain {
		from {
			transform: scaleX(1);
		}
		to {
			transform: scaleX(0);
		}
	}
	@keyframes sweep {
		0%,
		100% {
			transform: translateX(0%) scaleX(0.25);
		}
		50% {
			transform: translateX(75%) scaleX(0.25);
		}
	}
	.spin {
		animation: spin 900ms linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	/* Motion is never the only signal here — "Posting…" says it in words, and a pending toast has no
	   timer to race — so all three animations simply stop. The sweep parks as a short static bar. */
	@media (prefers-reduced-motion: reduce) {
		.bar,
		.bar.indet,
		.spin {
			animation: none;
		}
		.bar.indet {
			transform: scaleX(0.25);
		}
	}
</style>
