<script lang="ts">
	// A transient, self-dismissing toast, top-right. One duration owns both jobs: a single
	// setTimeout is the dismiss authority, and the bottom bar animates over the SAME value (set
	// inline as --dur), so they can't drift and the toast still dismisses under reduced-motion
	// (which would kill an animationend). Presentational: the caller owns when it fires (remount
	// per id to restart) and what ondone does.
	import { onMount } from "svelte";
	import { fly, fade } from "svelte/transition";

	let { message, ondone }: { message: string; ondone: () => void } = $props();

	// One duration, one lifetime: onMount runs once (the card is remounted per id to restart), so
	// the timer captures `ondone` once and never re-arms on a parent re-render — it stays locked to
	// the bar, which animates over the SAME --dur. Cleanup clears it if unmounted early.
	const MS = 3000;
	onMount(() => {
		const t = setTimeout(ondone, MS);
		return () => clearTimeout(t);
	});
</script>

<div
	class="toast"
	role="status"
	aria-live="polite"
	style={`--dur:${MS}ms`}
	in:fly={{ x: 16, duration: 180 }}
	out:fade={{ duration: 150 }}
>
	<div class="row">
		<svg
			class="check"
			width="15"
			height="15"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="3"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg
		>
		<span>{message}</span>
	</div>
	<div class="bar"></div>
</div>

<style>
	.toast {
		position: fixed;
		top: calc(var(--topbar) + 12px);
		right: 16px;
		z-index: 50;
		min-width: 180px;
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
		font-weight: 600;
		color: var(--foreground);
	}
	.check {
		flex: none;
		color: #16a34a;
	}
	/* the continuous countdown — shrinks left-to-right over the toast's lifetime */
	.bar {
		height: 3px;
		background: #16a34a;
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
