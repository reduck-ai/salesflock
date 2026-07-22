<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { navigating } from '$app/state';

	let { children } = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<!-- one thin top bar for any pending navigation (a filter change, a card step) — the global "working"
     signal; the card slot shows its own skeleton for card loads -->
{#if navigating.to}
	<div class="progress" role="presentation"></div>
{/if}

{@render children()}

<style>
	.progress {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		height: 2px;
		z-index: 100;
		background: var(--primary);
		transform-origin: left;
		animation: grow 8s cubic-bezier(0.1, 0.8, 0.2, 1) forwards;
	}
	@keyframes grow {
		0% {
			transform: scaleX(0);
		}
		100% {
			transform: scaleX(0.95);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.progress {
			animation: none;
			transform: scaleX(0.4);
		}
	}
</style>
