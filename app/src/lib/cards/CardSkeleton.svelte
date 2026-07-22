<script lang="ts">
	// The card placeholder shown while the next decision loads (the one slow op — a Notion page +
	// renderEvidence). Only the card slot swaps to this; the rail/header persist (layout data doesn't
	// reload on a card step), so a step reads as "this pane is filling in", not a full-page reload.
</script>

<div class="sk" aria-busy="true" aria-label="Loading decision">
	<div class="line w40 lg"></div>
	<div class="line w70"></div>
	<div class="box"></div>
	<div class="line w25 sm mt"></div>
	<div class="line w90"></div>
	<div class="line w85"></div>
	<div class="line w60"></div>
</div>

<style>
	.sk {
		padding: 0.5rem 0;
	}
	.line,
	.box {
		background: var(--muted);
		border-radius: 6px;
		animation: pulse 1.2s ease-in-out infinite;
	}
	.line {
		height: 0.85rem;
		margin: 0.55rem 0;
	}
	.line.lg {
		height: 1.4rem;
	}
	.line.sm {
		height: 0.7rem;
	}
	.mt {
		margin-top: 1.6rem;
	}
	.box {
		height: 3rem;
		margin: 1rem 0;
	}
	.w25 {
		width: 25%;
	}
	.w40 {
		width: 40%;
	}
	.w60 {
		width: 60%;
	}
	.w70 {
		width: 70%;
	}
	.w85 {
		width: 85%;
	}
	.w90 {
		width: 90%;
	}
	@keyframes pulse {
		0%,
		100% {
			opacity: 0.55;
		}
		50% {
			opacity: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.line,
		.box {
			animation: none;
		}
	}
</style>
