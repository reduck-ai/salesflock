<script lang="ts">
	// One evidenced judgment: the AI proposal beside its evidence. On a laptop they are two
	// columns (proposal left, evidence right); on mobile the proposal floats over the evidence
	// like a composer. The reading order is verdict → statements → CTA: each statement's dot
	// takes its stance's colour (green for, red against); hover a claim to light up the exact
	// evidence it cites, click (or Tab / Shift+Tab) to scroll there. The judge's prose rationale
	// hides behind a discreet toggle. The note sits above the buttons; ⏎ accepts, Esc rejects,
	// ←/→ navigate.
	// Presentational: it owns feedback (resets on remount) and emits a verdict; meaning is the
	// caller's.
	import { fade } from "svelte/transition";
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
		onjudge?: (verdict: Verdict, feedback: string, cta?: string) => void;
		onnav?: (dir: -1 | 1) => void;
	} = $props();

	let feedback = $state("");
	let ctaText = $state(judgment.cta?.text ?? ""); // the human's CTA edit (card remounts per id)
	let activeMi = $state<number | null>(null); // the cursor: one quote (a mark index)
	let collapsed = $state(false);
	let unfolded = $state(false); // the rationale prose, folded away by default
	let evEl = $state<HTMLElement>();
	let panelEl = $state<HTMLElement>();

	// every quote in claim order, tagged with its statement index — the flat list the cursor
	// walks; a claim's marks are adjacent, so stepping reads claim by claim, proof by proof.
	// The CTA's quotes ride last, under the virtual index statements.length: one more claim
	// to the cursor, so Tab, miOf and the highlight machinery need no special case.
	const CTA_SI = $derived(judgment.statements.length);
	const marks = $derived([
		...judgment.statements.flatMap((s, i) => s.quotes.map((sel) => ({ si: i, sel }))),
		...(judgment.cta?.quotes ?? []).map((sel) => ({ si: CTA_SI, sel }))
	]);
	// the mark index of a statement's first quote — how the claim list addresses the cursor
	const miOf = (si: number) => judgment.statements.slice(0, si).reduce((n, s) => n + s.quotes.length, 0);
	// the tally: how contested the verdict is, before reading a word
	const nFor = $derived(judgment.statements.filter((s) => s.supporting).length);
	const nAgainst = $derived(judgment.statements.length - nFor);
	// the cursor's claim, floated over the evidence so claim and proof are read together;
	// on the CTA's index it reads as the proposed action itself
	const activeSi = $derived(activeMi === null ? null : marks[activeMi].si);
	const active = $derived(
		activeSi === null
			? null
			: (judgment.statements[activeSi] ?? { claim: ctaText || "Proposed next step", supporting: true })
	);

	// toggle .active on the cursor claim's marks and .current on the cursor's own (marks live
	// in {@html}, so we reach them through the container ref rather than reactive markup)
	$effect(() => {
		const el = evEl;
		const si = activeSi;
		const mi = activeMi;
		el?.querySelectorAll("mark.hl").forEach((m) => {
			m.classList.toggle("active", si !== null && m.getAttribute("data-si") === String(si));
			m.classList.toggle("current", mi !== null && m.getAttribute("data-mi") === String(mi));
		});
	});

	// center the proof in whatever scrolls: the evidence column when it scrolls itself
	// (laptop), else the window — in the band left visible above the floating panel (mobile)
	const goto = (i: number) => {
		activeMi = i;
		const m = evEl?.querySelector(`mark.hl[data-mi="${i}"]`);
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
	// the CTA edit travels only when it changed something — the judge's text stays canonical
	const ctaEdit = () => {
		const t = ctaText.trim();
		return judgment.cta?.text !== undefined && t && t !== judgment.cta.text ? t : undefined;
	};
	const decide = (v: Verdict) => onjudge?.(v, feedback.trim(), ctaEdit());

	// Enter accepts, Esc rejects, ←/→ navigate, Tab / Shift+Tab step through proofs — ignored while typing
	$effect(() => {
		const onkey = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
			// a focused button already turns Enter into its own click — don't decide twice
			if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) decide("accepted");
			else if (e.key === "Escape") decide("rejected");
			else if (e.key === "ArrowRight") onnav?.(1);
			else if (e.key === "ArrowLeft") onnav?.(-1);
			else if (e.key === "Tab") {
				e.preventDefault();
				const n = marks.length;
				if (!n) return;
				const at = activeMi ?? -1;
				goto(e.shiftKey ? ((at <= 0 ? n : at) - 1) % n : (at + 1) % n);
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
			<kbd>←</kbd><kbd>→</kbd> navigate · <kbd>Tab</kbd> proof · <kbd>⏎</kbd> accept ·
			<kbd>Esc</kbd> reject
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
						<div class="head">
							<div class="verdict"><Markdown source={judgment.verdict} /></div>
							{#if judgment.statements.length}
								<span class="tally" title={`${nFor} for · ${nAgainst} against`}>
									<span class="for">{nFor}✓</span><span class="agn">{nAgainst}✕</span>
								</span>
							{/if}
							{#if judgment.rationale}
								<button
									class="icon"
									class:on={unfolded}
									title="The judge's rationale"
									aria-label="The judge's rationale"
									aria-expanded={unfolded}
									onclick={() => (unfolded = !unfolded)}
								>
									<svg
										width="15"
										height="15"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg
									>
								</button>
							{/if}
						</div>

						{#if judgment.rationale}
							<div class="rationale" class:open={unfolded}>
								<div><Markdown source={judgment.rationale} /></div>
							</div>
						{/if}

						<div class="why">
							{#each judgment.statements as s, i (i)}
								<button
									class="claim"
									class:active={activeSi === i}
									class:against={!s.supporting}
									data-si={i}
									onmouseenter={() => (activeMi = miOf(i))}
									onfocus={() => (activeMi = miOf(i))}
									onclick={() => goto(miOf(i))}
								>
									<svg
										class="mark"
										width="13"
										height="13"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="3"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-label={s.supporting ? "supports the verdict" : "argues against the verdict"}
									>
										{#if s.supporting}
											<path d="M20 6 9 17l-5-5" />
										{:else}
											<path d="M18 6 6 18" /><path d="m6 6 12 12" />
										{/if}
									</svg>
									<span>{s.claim}</span>
								</button>
							{/each}
						</div>

						{#if judgment.cta}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="cta"
								class:active={activeSi === CTA_SI}
								onmouseenter={() => judgment.cta && (activeMi = miOf(CTA_SI))}
							>
								<Markdown source={judgment.cta.head} />
								{#if judgment.cta.text !== undefined}
									<textarea class="cta-text" bind:value={ctaText} rows="1" onfocus={() => goto(miOf(CTA_SI))}
									></textarea>
								{/if}
							</div>
						{/if}
					</div>

					<div class="acts-wrap">
						<input bind:value={feedback} class="note" placeholder="Optional note — why you (dis)agree" />
						<div class="acts">
							<button class="btn reject" onclick={() => decide("rejected")}>Reject <kbd>Esc</kbd></button>
							<button class="btn accept" onclick={() => decide("accepted")}>Accept <kbd>⏎</kbd></button>
						</div>
					</div>
				</div>
			</div>
		</div>

		<div class="ev-card" bind:this={evEl}>
			{#if active}
				<div class="float-wrap">
					{#key activeSi}
						<div class="float-claim" in:fade={{ duration: 120 }}>
							<span class="dots" aria-label={`claim ${(activeSi ?? 0) + 1} of ${judgment.statements.length}`}>
								{#each judgment.statements as s, i (i)}
									<span class="dot" class:against={!s.supporting} class:on={activeSi === i}></span>
								{/each}
								{#if judgment.cta}
									<span class="dot cta" class:on={activeSi === CTA_SI}></span>
								{/if}
							</span>
							<span>{active.claim}</span>
						</div>
					{/key}
				</div>
			{/if}
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

	/* the active claim, floating over the evidence — same surface family as .proposal.
	   The wrap is a zero-height sticky anchor, so the caption overlays the text without
	   shifting it when a claim (de)activates. */
	.float-wrap {
		position: sticky;
		top: 8px;
		height: 0;
		z-index: 5;
	}
	.float-claim {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		padding: 9px 13px;
		font-size: 13px;
		line-height: 1.5;
		background: color-mix(in oklch, var(--card) 88%, transparent);
		backdrop-filter: blur(16px) saturate(1.4);
		border: 1px solid var(--border);
		border-radius: 12px;
		box-shadow:
			0 2px 6px rgb(0 0 0 / 0.08),
			0 12px 32px -12px rgb(0 0 0 / 0.24);
	}
	/* one dot per claim, stance-coloured; the ring is the cursor. Quotes get no chrome —
	   the .current mark in the evidence is the quote-level indicator. */
	.float-claim .dots {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 7px;
		height: 19.5px; /* one text line — keeps the dots centred on the first line */
		margin-right: 2px;
	}
	.float-claim .dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #16a34a;
	}
	.float-claim .dot.against {
		background: #dc2626;
	}
	.float-claim .dot.on {
		box-shadow:
			0 0 0 2px var(--card),
			0 0 0 3.5px currentColor;
		color: #16a34a;
	}
	.float-claim .dot.against.on {
		color: #dc2626;
	}
	/* the CTA's dot: an action, not a stance — neutral */
	.float-claim .dot.cta {
		background: var(--muted-foreground);
	}
	.float-claim .dot.cta.on {
		color: var(--muted-foreground);
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

	.head {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 4px 18px 8px;
	}
	.verdict {
		flex: 1;
		min-width: 0;
	}
	.verdict :global(h1) {
		margin: 0;
		font-size: 20px;
		font-weight: 720;
		letter-spacing: -0.02em;
	}
	/* how contested the verdict is, before reading a word */
	.tally {
		flex: none;
		display: inline-flex;
		gap: 7px;
		font-family: ui-monospace, monospace;
		font-size: 11px;
		font-weight: 600;
	}
	.tally .for {
		color: #16a34a;
	}
	.tally .agn {
		color: #dc2626;
	}
	.icon {
		flex: none;
		width: 26px;
		height: 26px;
		border-radius: 8px;
		border: none;
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
		display: grid;
		place-items: center;
		transition:
			background 0.15s ease,
			color 0.15s ease;
	}
	.icon:hover {
		color: var(--foreground);
	}
	.icon.on {
		color: var(--foreground);
		background: var(--accent);
	}

	/* the judge's prose — folded away until asked for */
	.rationale {
		display: grid;
		grid-template-rows: 0fr;
		opacity: 0;
		transition:
			grid-template-rows 0.22s ease,
			opacity 0.18s ease;
	}
	.rationale > div {
		overflow: hidden;
		padding: 0 18px;
		font-size: 13px;
		line-height: 1.55;
		color: var(--muted-foreground);
	}
	.rationale.open {
		grid-template-rows: 1fr;
		opacity: 1;
		margin-bottom: 10px;
	}

	.why {
		padding: 0 18px 12px;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.claim {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		width: 100%;
		text-align: left;
		font: inherit;
		font-size: 13px;
		line-height: 1.5;
		color: var(--foreground);
		background: none;
		border: none;
		padding: 6px 10px;
		border-radius: 9px;
		cursor: pointer;
		transition: background 0.15s ease;
	}
	/* the stance mark: ✓ argues for the verdict, ✕ against — shape first, colour second */
	.claim .mark {
		flex: none;
		margin-top: 3px;
		color: #16a34a;
	}
	.claim.against .mark {
		color: #dc2626;
	}
	.claim:hover,
	.claim:focus-visible,
	.claim.active {
		background: var(--accent);
		outline: none;
	}
	/* the proposed next action — the last thing read before deciding. Active like a claim
	   when the cursor is on its quotes; the body is the human's to edit in place. */
	.cta {
		margin: 4px 8px 14px;
		padding: 10px 10px 0;
		border-top: 1px solid var(--border);
		border-radius: 9px;
		font-size: 13px;
		line-height: 1.55;
		transition: background 0.15s ease;
	}
	.cta.active {
		background: var(--accent);
	}
	.cta-text {
		width: 100%;
		margin-top: 4px;
		padding: 6px 9px;
		border: 1px solid transparent;
		border-radius: 9px;
		background: transparent;
		font: inherit;
		font-style: italic;
		color: var(--foreground);
		resize: none;
		field-sizing: content; /* grows with the edit */
	}
	.cta-text:hover {
		border-color: var(--input);
	}
	.cta-text:focus {
		outline: none;
		border-color: var(--ring);
		background: var(--card);
		box-shadow: 0 0 0 3px color-mix(in oklch, var(--ring) 30%, transparent);
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
		.head {
			padding-top: 16px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		* {
			transition: none !important;
		}
	}
</style>
