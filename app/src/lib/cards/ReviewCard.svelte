<script lang="ts">
	// One evidenced judgment: the AI proposal beside its evidence. On a laptop they are two
	// columns (proposal left, evidence right); on mobile the proposal floats over the evidence
	// like a composer. Verdict first, reasoning as claims — hover a claim to light up the exact
	// evidence it cites, click (or Tab / Shift+Tab) to scroll there; a hollow dot marks a claim
	// with no verbatim quote. The note sits above the buttons; A/R decide, ←/→ navigate.
	// Presentational: it owns feedback (resets on remount) and emits a verdict; meaning is the
	// caller's.
	import Markdown from "$lib/components/Markdown.svelte";
	import type { EvidencedJudgment, Verdict } from "./types";

	let {
		judgment,
		pos,
		total,
		onjudge,
		onnav
	}: {
		judgment: EvidencedJudgment;
		pos: number;
		total: number;
		onjudge?: (verdict: Verdict, feedback: string) => void;
		onnav?: (dir: -1 | 1) => void;
	} = $props();

	let feedback = $state("");
	let activeSi = $state<number | null>(null);
	let collapsed = $state(false);
	let evEl = $state<HTMLElement>();
	let panelEl = $state<HTMLElement>();

	// every quote, tagged with its statement index — one hover lights all of a claim's proof
	const marks = $derived(judgment.statements.flatMap((s, i) => s.quotes.map((sel) => ({ si: i, sel }))));
	// the claims that actually cite evidence — the Tab cycle's stops
	const proven = $derived(judgment.statements.flatMap((s, i) => (s.quotes.length ? [i] : [])));

	// toggle .active on the marks of the hovered/clicked claim (marks live in {@html}, so
	// we reach them through the container ref rather than reactive markup)
	$effect(() => {
		const el = evEl;
		const si = activeSi;
		el?.querySelectorAll("mark.hl").forEach((m) =>
			m.classList.toggle("active", si !== null && m.getAttribute("data-si") === String(si))
		);
	});

	// center the proof in whatever scrolls: the evidence column when it scrolls itself
	// (laptop), else the window — in the band left visible above the floating panel (mobile)
	const goto = (i: number) => {
		activeSi = i;
		const m = evEl?.querySelector(`mark.hl[data-si="${i}"]`);
		if (!m || !evEl || !panelEl) return;
		if (getComputedStyle(evEl).overflowY === "auto") {
			const ev = evEl.getBoundingClientRect();
			evEl.scrollBy({
				top: m.getBoundingClientRect().top - ev.top - ev.height / 2,
				behavior: "smooth"
			});
		} else {
			const band = panelEl.getBoundingClientRect().top;
			window.scrollBy({ top: m.getBoundingClientRect().top - band / 2, behavior: "smooth" });
		}
	};
	const decide = (v: Verdict) => onjudge?.(v, feedback.trim());

	// A/R decide, ←/→ navigate, Tab / Shift+Tab step through proofs — ignored while typing
	$effect(() => {
		const onkey = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
			if (e.key === "a" || e.key === "A") decide("accepted");
			else if (e.key === "r" || e.key === "R") decide("rejected");
			else if (e.key === "ArrowRight") onnav?.(1);
			else if (e.key === "ArrowLeft") onnav?.(-1);
			else if (e.key === "Tab") {
				e.preventDefault();
				if (!proven.length) return;
				const at = proven.indexOf(activeSi ?? -1);
				const next = e.shiftKey
					? proven[(at <= 0 ? proven.length : at) - 1]
					: proven[(at + 1) % proven.length];
				goto(next);
			}
		};
		window.addEventListener("keydown", onkey);
		return () => window.removeEventListener("keydown", onkey);
	});
</script>

<div class="page">
	<div class="rail" title={`${pos} / ${total}`}>
		<div class="fill" style={`width:${(pos / total) * 100}%`}></div>
	</div>
	<div class="meta">
		<span>{pos} / {total}</span>
		<span class="hint">
			<kbd>←</kbd><kbd>→</kbd> navigate · <kbd>Tab</kbd> proof · <kbd>A</kbd> accept ·
			<kbd>R</kbd> reject
		</span>
	</div>

	<div class="cols">
		<div class="proposal" class:collapsed bind:this={panelEl}>
			<button
				class="handle"
				title="Collapse"
				aria-label="Collapse panel"
				onclick={() => (collapsed = !collapsed)}
			>
				<svg
					class="chev"
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2.2"
					stroke-linecap="round"
					stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg
				>
			</button>

			<div class="body">
				<div>
					<div class="scroll">
						<div class="verdict"><Markdown source={judgment.verdict} /></div>

						<div class="why">
							{#each judgment.statements as s, i (i)}
								<button
									class="claim"
									class:active={activeSi === i}
									class:unproven={!s.quotes.length}
									title={s.quotes.length ? undefined : "No verbatim quote in the evidence"}
									data-si={i}
									onmouseenter={() => (activeSi = i)}
									onfocus={() => (activeSi = i)}
									onclick={() => goto(i)}
								>
									{s.claim}
								</button>
							{/each}
						</div>
					</div>

					<div class="acts-wrap">
						<input bind:value={feedback} class="note" placeholder="Optional note — why you (dis)agree" />
						<div class="acts">
							<button class="btn reject" onclick={() => decide("rejected")}>Reject <kbd>R</kbd></button>
							<button class="btn accept" onclick={() => decide("accepted")}>Accept <kbd>A</kbd></button>
						</div>
					</div>
				</div>
			</div>
		</div>

		<div class="ev-card" bind:this={evEl}>
			<Markdown source={judgment.evidence} highlights={marks} class="evidence" />
		</div>
	</div>
</div>

<div class="veil"></div>

<style>
	.page {
		max-width: 760px;
		margin: 0 auto;
		padding: 0 4px 340px; /* deep bottom pad: last evidence clears the floating panel */
	}
	.rail {
		height: 3px;
		border-radius: 2px;
		background: var(--border);
		overflow: hidden;
		margin-bottom: 10px;
	}
	.rail .fill {
		height: 100%;
		background: var(--ring);
	}
	.meta {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		font-family: ui-monospace, monospace;
		font-size: 11.5px;
		color: var(--muted-foreground);
		margin-bottom: 14px;
	}
	.meta kbd {
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 1px 5px;
		margin: 0 1px;
	}

	.ev-card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 16px;
		padding: 8px 24px 20px;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.04);
	}
	.ev-card :global(.evidence h3) {
		font-family: ui-monospace, monospace;
		font-size: 10.5px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted-foreground);
		margin: 18px 0 6px;
	}
	.ev-card :global(.evidence h3:first-child) {
		margin-top: 6px;
	}
	.ev-card :global(pre) {
		white-space: pre-wrap; /* YAML evidence blocks wrap instead of bleeding past the card */
		overflow-wrap: anywhere;
	}

	.veil {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		height: 230px;
		pointer-events: none;
		background: linear-gradient(to top, var(--background) 36%, transparent);
	}

	/* mobile default: the proposal floats over the evidence, bottom-docked */
	.proposal {
		position: fixed;
		left: 20px;
		right: 20px;
		bottom: 22px;
		max-width: 640px;
		margin: 0 auto;
		z-index: 10;
		background: color-mix(in oklch, var(--card) 88%, transparent);
		backdrop-filter: blur(16px) saturate(1.4);
		border: 1px solid var(--border);
		border-radius: 22px;
		box-shadow:
			0 2px 6px rgb(0 0 0 / 0.08),
			0 24px 60px -18px rgb(0 0 0 / 0.28);
		overflow: hidden;
	}

	.handle {
		width: 100%;
		height: 22px;
		border: none;
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
		display: grid;
		place-items: center;
	}
	.handle:hover {
		color: var(--foreground);
	}
	.chev {
		transition: transform 0.22s ease;
	}
	.proposal.collapsed .chev {
		transform: rotate(180deg);
	}

	.body {
		display: grid;
		grid-template-rows: 1fr;
		transition: grid-template-rows 0.24s ease;
	}
	.proposal.collapsed .body {
		grid-template-rows: 0fr;
	}
	.body > div {
		overflow: hidden;
		min-width: 0;
	}

	.verdict {
		padding: 4px 18px 8px;
	}
	.verdict :global(h1) {
		margin: 0;
		font-size: 20px;
		font-weight: 720;
		letter-spacing: -0.02em;
	}

	.why {
		padding: 0 18px 12px;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.claim {
		position: relative;
		width: 100%;
		text-align: left;
		font: inherit;
		font-size: 13px;
		line-height: 1.5;
		color: var(--foreground);
		background: none;
		border: none;
		padding: 6px 10px 6px 26px;
		border-radius: 9px;
		cursor: pointer;
		transition: background 0.15s ease;
	}
	.claim::before {
		content: "";
		position: absolute;
		left: 11px;
		top: 12px;
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--muted-foreground);
	}
	/* a claim with no verbatim quote: hollow dot — nothing to light up in the evidence */
	.claim.unproven::before {
		background: transparent;
		border: 1px solid var(--muted-foreground);
	}
	.claim:hover,
	.claim:focus-visible,
	.claim.active {
		background: var(--accent);
		outline: none;
	}
	.acts-wrap {
		border-top: 1px solid var(--border);
		padding: 12px 14px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.note {
		width: 100%;
		height: 40px;
		border: 1px solid var(--input);
		background: var(--card);
		border-radius: 11px;
		padding: 0 13px;
		font-size: 13px;
		color: var(--foreground);
	}
	.note::placeholder {
		color: var(--muted-foreground);
	}
	.note:focus {
		outline: none;
		border-color: var(--ring);
		box-shadow: 0 0 0 3px color-mix(in oklch, var(--ring) 30%, transparent);
	}
	.acts {
		display: flex;
		gap: 10px;
	}
	.btn {
		flex: 1;
		height: 44px;
		border-radius: 12px;
		border: none;
		cursor: pointer;
		font-size: 14.5px;
		font-weight: 640;
		color: #fff;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 9px;
		transition: filter 0.12s ease;
	}
	.btn:hover {
		filter: brightness(1.06);
	}
	.btn kbd {
		font-family: ui-monospace, monospace;
		font-size: 10.5px;
		font-weight: 600;
		padding: 2px 6px;
		border-radius: 5px;
		background: rgb(255 255 255 / 0.24);
	}
	.btn.reject {
		background: #dc2626;
	}
	.btn.accept {
		background: #16a34a;
	}

	/* laptop: the viewport is the app — the page fills the height the header leaves,
	   the two columns split it, and ONLY their insides scroll. In the proposal, the
	   verdict + claims scroll while the note + verdict buttons stay pinned below. */
	@media (min-width: 1024px) {
		.page {
			max-width: none;
			padding-bottom: 0;
			flex: 1;
			min-height: 0;
			display: flex;
			flex-direction: column;
		}
		.cols {
			flex: 1;
			min-height: 0;
			display: grid;
			grid-template-columns: minmax(360px, 420px) 1fr;
			gap: 24px;
		}
		.ev-card {
			min-width: 0; /* grid item: long evidence lines wrap instead of blowing the column out */
			min-height: 0;
			overflow-y: auto;
			overflow-wrap: anywhere;
		}
		.proposal {
			position: static;
			max-width: none;
			min-height: 0;
			margin: 0;
			background: var(--card);
			backdrop-filter: none;
			border-radius: 16px;
			box-shadow: 0 1px 2px rgb(0 0 0 / 0.04);
			display: flex;
			flex-direction: column;
		}
		.body,
		.proposal.collapsed .body {
			flex: 1;
			min-height: 0;
			grid-template-rows: 1fr;
		}
		.body > div {
			display: flex;
			flex-direction: column;
		}
		.scroll {
			flex: 1;
			min-height: 0;
			overflow-y: auto;
		}
		.handle,
		.veil {
			display: none;
		}
		.verdict {
			padding-top: 16px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		* {
			transition: none !important;
		}
	}
</style>
