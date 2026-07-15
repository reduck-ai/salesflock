<script lang="ts">
	// One evidenced judgment: the evidence is the page (it carries who), the judgment floats
	// over it like a composer. Verdict first, reasoning as claims — hover a claim to light up
	// the exact evidence it cites, click to scroll there. Note is progressive (pencil), the
	// panel collapses to just its handle, and A/R decide while ←/→ navigate. Presentational:
	// it owns feedback (resets on remount) and emits a verdict; meaning is the caller's.
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
	let noting = $state(false);
	let collapsed = $state(false);
	let evEl = $state<HTMLElement>();
	let dockEl = $state<HTMLElement>();
	let noteEl = $state<HTMLInputElement>();

	// every quote, tagged with its statement index — one hover lights all of a claim's proof
	const marks = $derived(judgment.statements.flatMap((s, i) => s.quotes.map((sel) => ({ si: i, sel }))));

	// toggle .active on the marks of the hovered/clicked claim (marks live in {@html}, so
	// we reach them through the container ref rather than reactive markup)
	$effect(() => {
		const el = evEl;
		const si = activeSi;
		el?.querySelectorAll("mark.hl").forEach((m) =>
			m.classList.toggle("active", si !== null && m.getAttribute("data-si") === String(si))
		);
	});

	// center the proof in the band above the panel — viewport center may sit behind it
	const goto = (i: number) => {
		activeSi = i;
		const m = evEl?.querySelector(`mark.hl[data-si="${i}"]`);
		if (!m || !dockEl) return;
		const band = dockEl.getBoundingClientRect().top;
		window.scrollBy({ top: m.getBoundingClientRect().top - band / 2, behavior: "smooth" });
	};
	const decide = (v: Verdict) => onjudge?.(v, feedback.trim());
	const toggleNote = () => {
		noting = !noting;
		if (noting) queueMicrotask(() => noteEl?.focus());
	};

	// A/R decide, ←/→ navigate — ignored while typing a note
	$effect(() => {
		const onkey = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
			if (e.key === "a" || e.key === "A") decide("accepted");
			else if (e.key === "r" || e.key === "R") decide("rejected");
			else if (e.key === "ArrowRight") onnav?.(1);
			else if (e.key === "ArrowLeft") onnav?.(-1);
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
		<span class="hint"><kbd>←</kbd><kbd>→</kbd> navigate · <kbd>A</kbd> accept · <kbd>R</kbd> reject</span>
	</div>

	<div class="ev-card" bind:this={evEl}>
		<Markdown source={judgment.evidence} highlights={marks} class="evidence" />
	</div>
</div>

<div class="veil"></div>

<div class="dock">
	<div class="judgment" class:collapsed bind:this={dockEl}>
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
				<div class="head">
					<div class="verdict"><Markdown source={judgment.verdict} /></div>
					<button
						class="icon"
						class:on={noting}
						title="Add a note"
						aria-label="Add a note"
						onclick={toggleNote}
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
							><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg
						>
					</button>
				</div>

				<div class="why">
					{#each judgment.statements as s, i (i)}
						<button
							class="claim"
							data-si={i}
							onmouseenter={() => (activeSi = i)}
							onmouseleave={() => (activeSi = null)}
							onfocus={() => (activeSi = i)}
							onblur={() => (activeSi = null)}
							onclick={() => goto(i)}
						>
							{s.claim}
						</button>
					{/each}
				</div>

				<div class="acts-wrap">
					<div class="note-zone" class:open={noting}>
						<div>
							<input
								bind:this={noteEl}
								bind:value={feedback}
								class="note"
								placeholder="Optional note — why you (dis)agree"
							/>
						</div>
					</div>
					<div class="acts">
						<button class="btn reject" onclick={() => decide("rejected")}>Reject <kbd>R</kbd></button>
						<button class="btn accept" onclick={() => decide("accepted")}>Accept <kbd>A</kbd></button>
					</div>
				</div>
			</div>
		</div>
	</div>
</div>

<style>
	.page {
		max-width: 760px;
		margin: 0 auto;
		padding: 0 4px 340px; /* deep bottom pad: last evidence clears the dock */
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

	.veil {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		height: 230px;
		pointer-events: none;
		background: linear-gradient(to top, var(--background) 36%, transparent);
	}

	.dock {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 22px;
		display: flex;
		justify-content: center;
		padding: 0 20px;
	}
	.judgment {
		position: relative;
		width: 100%;
		max-width: 640px;
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
	.judgment.collapsed .chev {
		transform: rotate(180deg);
	}

	.body {
		display: grid;
		grid-template-rows: 1fr;
		transition: grid-template-rows 0.24s ease;
	}
	.judgment.collapsed .body {
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
	.icon {
		flex: none;
		width: 31px;
		height: 31px;
		border-radius: 9px;
		border: 1px solid var(--border);
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
		border-color: transparent;
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
	.claim:hover,
	.claim:focus-visible {
		background: var(--accent);
		outline: none;
	}
	.acts-wrap {
		border-top: 1px solid var(--border);
		padding: 12px 14px;
	}
	.note-zone {
		display: grid;
		grid-template-rows: 0fr;
		opacity: 0;
		transition:
			grid-template-rows 0.22s ease,
			opacity 0.18s ease,
			margin 0.22s ease;
	}
	.note-zone > div {
		overflow: hidden;
	}
	.note-zone.open {
		grid-template-rows: 1fr;
		opacity: 1;
		margin-bottom: 10px;
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

	@media (prefers-reduced-motion: reduce) {
		* {
			transition: none !important;
		}
	}
</style>
