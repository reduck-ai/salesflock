<script lang="ts">
	// One evidenced judgment, read like a chat: the evidence is the document (one column,
	// window scroll), and the dock — the single interaction surface, styled like a composer —
	// floats at the bottom with the AI's whole proposal: verdict, the claims (each with one
	// dot per proof), the editable drafted next step, and the human's actions. Every quote is
	// highlighted in the evidence at all times, stance-coloured and subtle, with its claim
	// pinned in the right margin like a doc comment. One cursor: click a claim, a dot, or a
	// margin note — or press Tab/Shift+Tab — to focus a quote and scroll it into view.
	// ⏎ accepts, Esc rejects, ←/→ navigate.
	// The human can also talk back at the reasoning: a comment on any claim, and a
	// Notion-style selection menu over the evidence to add a new claim (✓/✕) or attach the
	// quote to an existing one — all edits to a local copy of the statements; the judge's
	// stay canonical and the copy travels with the verdict only when it differs.
	// Presentational: it owns feedback (resets on remount) and emits a verdict; meaning is the
	// caller's.
	import Markdown from "$lib/components/Markdown.svelte";
	import { resolveVisible, quoteKey } from "$core/anchor";
	import type { EvidencedJudgment, Selector, Statement, Verdict } from "./types";

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
		onjudge?: (verdict: Verdict | undefined, feedback: string, cta?: string, reasoning?: Statement[]) => void;
		onnav?: (dir: -1 | 1) => void;
	} = $props();

	// seed from a saved draft when one exists, else from the judge's — so a checkpointed
	// review resumes where it was left. The judge's statements stay canonical on the prop
	// (provenance is read off `judgment.statements`, never this editable copy).
	let feedback = $state(judgment.draft?.feedback ?? "");
	let noting = $state(!!judgment.draft?.feedback); // the note field, open when a draft has one
	let ctaText = $state(judgment.cta?.text ?? ""); // the human's CTA edit (card remounts per id)
	// the human's editable copy of the reasoning — comments and added claims/quotes land here;
	// the judge's statements stay canonical on the prop (the card remounts per id)
	let statements = $state<Statement[]>(structuredClone(judgment.draft?.reasoning ?? judgment.statements));
	// the selection menu — its selector is minted at mouseup: verbatim-or-refuse, the judge's contract
	let menu = $state<{ selector: Selector | null; x: number; y: number } | null>(null);
	let menuMode = $state<"acts" | "claim" | "attach">("acts");
	let stance = $state(true); // the new claim's stance, picked before its text is typed
	let claimText = $state("");
	let menuEl = $state<HTMLElement>();
	let activeMi = $state<number | null>(null); // the cursor: one quote (a mark index)
	let unfolded = $state(false); // the rationale prose, folded away by default
	let evEl = $state<HTMLElement>();
	let dockEl = $state<HTMLElement>();

	// every quote in claim order, tagged with its statement index — the flat list the cursor
	// walks; a claim's marks are adjacent, so stepping reads claim by claim, proof by proof.
	// The CTA is not on the walk: it IS the draft in the dock, not a claim to verify.
	const marks = $derived(statements.flatMap((s, i) => s.quotes.map((sel) => ({ si: i, sel }))));
	// the mark index of a statement's first quote — how the claim list addresses the cursor
	const miOf = (si: number) => statements.slice(0, si).reduce((n, s) => n + s.quotes.length, 0);
	const activeSi = $derived(activeMi === null ? null : marks[activeMi].si);

	// provenance, derived from the canonical prop — never stored. A claim or quote is the
	// human's iff it isn't in the judge's frozen judgment; the judge's stay immutable
	// labelling data, only the human's are editable. Same identity `diffStatements` uses.
	const original = $derived(
		new Map(judgment.statements.map((s) => [s.claim, new Set(s.quotes.map(quoteKey))]))
	);
	const isUserClaim = (claim: string) => !original.has(claim);
	const isUserQuote = (claim: string, sel: Selector) => !original.get(claim)?.has(quoteKey(sel));
	// the focused quote is the human's — the one removal predicate the ✕ and ⌫ both gate on
	const canRemove = (mi: number | null): boolean => {
		if (mi === null) return false;
		const { si } = marks[mi];
		return isUserQuote(statements[si].claim, statements[si].quotes[mi - miOf(si)]);
	};
	// remove the focused quote; when it was the last quote of a human claim, the claim goes
	// with it (a claim without proof is not a statement). The judge's quotes never qualify.
	const removeFocused = () => {
		if (!canRemove(activeMi)) return;
		const si = marks[activeMi!].si;
		const s = statements[si];
		if (s.quotes.length > 1) s.quotes.splice(activeMi! - miOf(si), 1);
		else statements.splice(si, 1);
		activeMi = null;
	};

	// stance and focus onto the rendered marks (they live in {@html}, so we reach them through
	// the container ref): .against colours a quote by its claim's stance, .active lights up the
	// cursor claim's quotes together, .current singles out the cursor's own.
	$effect(() => {
		const el = evEl;
		const si = activeSi;
		const mi = activeMi;
		el?.querySelectorAll("mark.hl").forEach((m) => {
			const s = statements[Number(m.getAttribute("data-si"))];
			m.classList.toggle("against", s ? !s.supporting : false);
			m.classList.toggle("active", si !== null && m.getAttribute("data-si") === String(si));
			m.classList.toggle("current", mi !== null && m.getAttribute("data-mi") === String(mi));
		});
	});

	// the margin notes — each claim pinned beside its first proof, doc-comment style. A pin's
	// top is a pure function of its anchor mark's top and the MEASURED heights of the pins
	// above it (bind:clientHeight — reactive, so expansion/replies re-stack and overlap is
	// impossible by construction; no estimated height). Anchors re-measure on resize (line
	// wrapping moves the marks); heights depend only on content and the gutter's fixed width,
	// never on top, so measure→place settles in one pass.
	const GAP = 10;
	let vw = $state(0);
	let sy = $state(0);
	let anchors = $state<{ si: number; top: number }[]>([]);
	let heights = $state<Record<number, number>>({});
	$effect(() => {
		void vw;
		void sy; // re-anchor on scroll: a claim's note tracks its nearest quote
		const el = evEl;
		if (!el || !marks.length) {
			anchors = [];
			return;
		}
		const base = el.getBoundingClientRect().top;
		// pin each claim beside the one of its quotes nearest the line goto() parks a focused
		// quote at, so a claim with several proofs keeps its note beside the one in view — never
		// stranded off-screen at the first, never doubled. In document order (claims and quotes
		// are ordered independently).
		const line = (dockEl ? dockEl.getBoundingClientRect().top / 2 : window.innerHeight / 2) - base;
		anchors = statements
			.flatMap((_, si) => {
				const tops = [...el.querySelectorAll(`mark.hl[data-si="${si}"]`)].map(
					(m) => m.getBoundingClientRect().top - base
				);
				if (!tops.length) return [];
				const top = tops.reduce((a, b) => (Math.abs(b - line) < Math.abs(a - line) ? b : a));
				return { si, top };
			})
			.sort((a, b) => a.top - b.top);
	});
	// the floor walk: each pin lands at its anchor, pushed down only past the one just above
	const notes = $derived.by(() => {
		let floor = 0;
		return anchors.map(({ si, top }) => {
			const at = Math.max(top, floor);
			floor = at + (heights[si] ?? 0) + GAP;
			return { si, top: at };
		});
	});

	// center the proof in the band the dock leaves visible above it
	const goto = (i: number) => {
		activeMi = i;
		const m = evEl?.querySelector(`mark.hl[data-mi="${i}"]`);
		if (!m || !dockEl) return;
		const band = dockEl.getBoundingClientRect().top;
		window.scrollBy({ top: m.getBoundingClientRect().top - band / 2, behavior: "smooth" });
	};
	// the CTA edit travels only when it changed something — the judge's text stays canonical
	const ctaEdit = () => {
		const t = ctaText.trim();
		return judgment.cta?.text !== undefined && t && t !== judgment.cta.text ? t : undefined;
	};
	// likewise the reasoning: the edited copy travels only when it differs from the judge's.
	// Empty comments are dropped, so an opened-then-abandoned field is not an edit.
	const reasoningEdit = (): Statement[] | undefined => {
		const edited = $state
			.snapshot(statements)
			.map(({ comment, ...s }) => (comment?.trim() ? { ...s, comment: comment.trim() } : s));
		return JSON.stringify(edited) !== JSON.stringify(judgment.statements) ? edited : undefined;
	};
	// v omitted = Save: the same judgment, decision withheld. The parent persists either way.
	const decide = (v?: Verdict) => onjudge?.(v, feedback.trim(), ctaEdit(), reasoningEdit());
	export function save() {
		decide();
	}

	// the selection menu opens on mouseup over a selection inside the evidence; the selector
	// is minted right away — an unresolvable selection (markdown syntax in the span) shows a
	// hint instead of actions, never a guessed anchor.
	const onselect = (e: MouseEvent) => {
		if (menuEl?.contains(e.target as Node)) return;
		const s = window.getSelection();
		const text = s && !s.isCollapsed ? s.toString().trim() : "";
		if (!text || !evEl?.contains(s!.anchorNode)) {
			menu = null;
			return;
		}
		const r = s!.getRangeAt(0).getBoundingClientRect();
		menuMode = "acts";
		claimText = "";
		menu = { selector: resolveVisible(judgment.evidence, text), x: r.left + r.width / 2, y: r.top };
	};
	const closeMenu = () => {
		menu = null;
		window.getSelection()?.removeAllRanges();
	};
	const addClaim = () => {
		const claim = claimText.trim();
		if (!claim || !menu?.selector) return;
		statements.push({ claim, supporting: stance, quotes: [menu.selector] });
		closeMenu();
	};
	const attach = (si: number) => {
		if (menu?.selector) statements[si].quotes.push(menu.selector);
		closeMenu();
	};

	// the window scroll is shared chrome — each card starts at the top of its evidence
	$effect(() => window.scrollTo(0, 0));

	// ⏎ accepts, Esc rejects, ←/→ navigate, Tab / Shift+Tab step through proofs — ignored
	// while typing
	$effect(() => {
		const onkey = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
			// the selection menu owns the keys while open — Esc closes it, nothing else fires
			if (menu) {
				if (e.key === "Escape") closeMenu();
				return;
			}
			// a focused button already turns Enter into its own click — don't decide twice
			if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) decide("accepted");
			else if (e.key === "Escape") decide("rejected");
			else if (e.key === "ArrowRight") onnav?.(1);
			else if (e.key === "ArrowLeft") onnav?.(-1);
			else if ((e.key === "Backspace" || e.key === "Delete") && canRemove(activeMi)) {
				e.preventDefault();
				removeFocused();
			} else if (e.key === "Tab") {
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

<svelte:window
	bind:innerWidth={vw}
	bind:scrollY={sy}
	onmouseup={onselect}
	onmousedown={(e) => menu && !menuEl?.contains(e.target as Node) && (menu = null)}
	onclick={(e) => {
		// a quote is clickable, à la Notion: focus it and its margin comment expands.
		// A click anywhere else — outside a quote, its pin, or a dock claim — unselects.
		const t = e.target as Element;
		const m = t.closest?.("mark.hl");
		if (m && evEl?.contains(m)) activeMi = Number(m.getAttribute("data-mi"));
		else if (!t.closest?.(".note-pin, .claim, .selmenu")) activeMi = null;
	}}
/>

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

	<div class="doc" bind:this={evEl}>
		<Markdown source={judgment.evidence} highlights={marks} class="evidence" />
		<div class="gutter">
			{#each notes as n (n.si)}
				<div
					class="note-pin"
					class:against={!statements[n.si].supporting}
					class:on={activeSi === n.si}
					style={`top:${n.top}px`}
					bind:clientHeight={heights[n.si]}
				>
					<button onclick={() => goto(miOf(n.si))}>
						<span>{statements[n.si].claim}</span>
					</button>
					{#if activeSi === n.si}
						<input
							class="reply"
							bind:value={statements[n.si].comment}
							placeholder="Reply…"
							onkeydown={(e) => (e.key === "Enter" || e.key === "Escape") && e.currentTarget.blur()}
						/>
					{:else if statements[n.si].comment}
						<div class="cmt">{statements[n.si].comment}</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>
</div>

<div class="veil"></div>

{#if menu}
	<div class="selmenu" bind:this={menuEl} style={`left:${menu.x}px; top:${menu.y}px`}>
		{#if !menu.selector}
			<span class="nohit">Can't anchor — select the text verbatim, within one block</span>
		{:else if menuMode === "acts"}
			<button class="act for" onclick={() => ((stance = true), (menuMode = "claim"))}> ✓ New claim </button>
			<button class="act against" onclick={() => ((stance = false), (menuMode = "claim"))}>
				✕ New claim
			</button>
			<button class="act" onclick={() => (menuMode = "attach")}>Add to claim…</button>
		{:else if menuMode === "claim"}
			<input
				class="claim-in"
				bind:value={claimText}
				placeholder={stance ? "The claim this supports…" : "The claim this cuts against…"}
				{@attach (el: HTMLInputElement) => el.focus()}
				onkeydown={(e) => (e.key === "Enter" ? addClaim() : e.key === "Escape" && closeMenu())}
			/>
		{:else}
			<div class="attach">
				{#each statements as s, i (i)}
					<button class="pick" class:against={!s.supporting} onclick={() => attach(i)}>
						<span class="glyph">{s.supporting ? "✓" : "✕"}</span><span>{s.claim}</span>
					</button>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<div class="dock" bind:this={dockEl}>
	<div class="head">
		<div class="verdict"><Markdown source={judgment.verdict} /></div>
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
		{#each statements as s, i (i)}
			<div class="claim" class:active={activeSi === i} class:against={!s.supporting}>
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
				<!-- the judge's claims are read-only labelling data; the human's own are editable -->
				{#if isUserClaim(s.claim)}
					<input
						class="text edit"
						aria-label="Edit claim"
						bind:value={statements[i].claim}
						onkeydown={(e) => (e.key === "Enter" || e.key === "Escape") && e.currentTarget.blur()}
					/>
				{:else}
					<button class="text" onclick={() => goto(miOf(i))}>{s.claim}</button>
				{/if}
				<span class="dots">
					{#each s.quotes as sel, j (j)}
						<button
							class="dot"
							class:on={activeMi === miOf(i) + j}
							class:userq={isUserQuote(s.claim, sel)}
							aria-label="proof"
							onclick={() => goto(miOf(i) + j)}
						></button>
					{/each}
				</span>
				{#if activeSi === i && canRemove(activeMi)}
					<button
						class="rm"
						title="Remove this quote (⌫)"
						aria-label="Remove this quote"
						onclick={removeFocused}>✕</button
					>
				{/if}
			</div>
		{/each}
	</div>

	{#if judgment.cta}
		<div class="cta">
			<Markdown source={judgment.cta.head} />
			{#if judgment.cta.text !== undefined}
				<textarea class="cta-text" bind:value={ctaText} rows="1"></textarea>
			{/if}
		</div>
	{/if}

	<div class="acts-wrap">
		<div class="acts">
			<button class="btn reject" onclick={() => decide("rejected")}>Reject <kbd>Esc</kbd></button>
			<button class="btn accept" onclick={() => decide("accepted")}>Accept <kbd>⏎</kbd></button>
			<button
				class="btn-note"
				class:on={noting}
				title="Add a note"
				aria-label="Add a note"
				aria-expanded={noting}
				onclick={() => (noting = !noting)}
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
					><path
						d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"
					/></svg
				>
			</button>
		</div>
		{#if noting}
			<input
				bind:value={feedback}
				class="note"
				placeholder="Optional note — why you (dis)agree"
				{@attach (el) => el.focus()}
			/>
		{/if}
	</div>
</div>

<style>
	.page {
		max-width: 720px;
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
	kbd {
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 1px 5px;
		margin: 0 1px;
	}

	/* the document: plain markdown, no chrome — the page itself scrolls */
	.doc {
		position: relative; /* the margin notes hang off it */
		padding: 0 12px;
		overflow-wrap: anywhere;
	}
	.doc :global(.evidence h3) {
		font-family: ui-monospace, monospace;
		font-size: 10.5px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted-foreground);
		margin: 18px 0 6px;
	}
	.doc :global(.evidence h3:first-child) {
		margin-top: 6px;
	}
	.doc :global(pre) {
		white-space: pre-wrap; /* YAML evidence blocks wrap instead of bleeding off the column */
		overflow-wrap: anywhere;
	}

	/* the margin notes — each claim pinned beside its first proof, doc-comment style */
	.gutter {
		position: absolute;
		top: 0;
		bottom: 0;
		left: calc(100% + 18px);
		width: 230px;
	}
	.note-pin {
		position: absolute;
		width: 100%;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted-foreground);
		background: var(--card);
		border: 1px solid var(--border);
		border-left: 2.5px solid #16a34a;
		border-radius: 10px;
		padding: 7px 10px;
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.07);
		transition:
			color 0.15s ease,
			border-color 0.15s ease,
			box-shadow 0.15s ease;
	}
	.note-pin button {
		display: block;
		width: 100%;
		text-align: left;
		font: inherit;
		color: inherit;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
	}
	.note-pin button > span {
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	/* the open comment reads in full, floating over its neighbours — Notion's expand */
	.note-pin.on button > span {
		-webkit-line-clamp: unset;
		line-clamp: unset;
	}
	/* the human's side of the thread: the note, or the Reply field while the pin is open */
	.note-pin .reply,
	.note-pin .cmt {
		width: 100%;
		margin-top: 6px;
		padding: 5px 0 0;
		border-top: 1px solid var(--border);
		font: inherit;
		font-size: 12px;
		color: var(--foreground);
	}
	.note-pin .reply {
		border-left: none;
		border-right: none;
		border-bottom: none;
		background: none;
		outline: none;
	}
	.note-pin .reply::placeholder {
		color: var(--muted-foreground);
	}
	.note-pin .cmt {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.note-pin.on {
		z-index: 1;
	}
	.note-pin.against {
		border-left-color: #dc2626;
	}
	.note-pin:hover,
	.note-pin.on {
		color: var(--foreground);
		box-shadow: 0 2px 8px rgb(0 0 0 / 0.1);
	}
	.note-pin.on {
		border-color: color-mix(in oklch, #16a34a 45%, var(--border));
		border-left-color: #16a34a;
	}
	.note-pin.against.on {
		border-color: color-mix(in oklch, #dc2626 45%, var(--border));
		border-left-color: #dc2626;
	}
	@media (max-width: 1260px) {
		.gutter {
			display: none; /* no margin room — the dock's claim list carries the mapping */
		}
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

	/* the selection menu — Notion-style, floated just above the highlighted text */
	.selmenu {
		position: fixed;
		transform: translate(-50%, calc(-100% - 10px));
		z-index: 30;
		display: flex;
		align-items: stretch;
		gap: 2px;
		padding: 4px;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 12px;
		box-shadow: 0 8px 30px rgb(0 0 0 / 0.16);
		max-width: min(440px, calc(100vw - 24px));
	}
	.selmenu .nohit {
		font-size: 12px;
		color: var(--muted-foreground);
		padding: 4px 8px;
		white-space: nowrap;
	}
	.selmenu .act {
		border: none;
		background: none;
		cursor: pointer;
		font: inherit;
		font-size: 12.5px;
		font-weight: 550;
		color: var(--foreground);
		padding: 5px 9px;
		border-radius: 8px;
		white-space: nowrap;
	}
	.selmenu .act:hover {
		background: var(--accent);
	}
	.selmenu .act.for {
		color: #16a34a;
	}
	.selmenu .act.against {
		color: #dc2626;
	}
	.selmenu .claim-in {
		width: 320px;
		max-width: calc(100vw - 60px);
		border: none;
		background: none;
		outline: none;
		font: inherit;
		font-size: 13px;
		padding: 5px 8px;
		color: var(--foreground);
	}
	.selmenu .attach {
		display: flex;
		flex-direction: column;
		max-height: 40vh;
		overflow-y: auto;
		min-width: 260px;
	}
	.selmenu .pick {
		display: flex;
		gap: 7px;
		align-items: flex-start;
		border: none;
		background: none;
		cursor: pointer;
		text-align: left;
		font: inherit;
		font-size: 12.5px;
		line-height: 1.45;
		padding: 6px 8px;
		border-radius: 8px;
		color: var(--foreground);
	}
	.selmenu .pick:hover {
		background: var(--accent);
	}
	.selmenu .pick .glyph {
		color: #16a34a;
		font-weight: 700;
	}
	.selmenu .pick.against .glyph {
		color: #dc2626;
	}

	/* the dock — the composer: the one surface where opinion lives */
	.dock {
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

	.head {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 14px 18px 6px;
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
		margin-bottom: 6px;
	}

	/* the claims — always visible, one dot per proof; the cursor lives in the dots */
	.why {
		padding: 2px 10px 8px;
		max-height: 32vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.claim {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		width: 100%;
		font-size: 13px;
		line-height: 1.5;
		color: var(--foreground);
		padding: 5px 8px;
		border-radius: 9px;
		transition: background 0.15s ease;
	}
	.claim:hover,
	.claim.active {
		background: var(--accent);
	}
	/* the claim text: the judge's is a button (click to focus its proof), the human's an
	   inline-editable input — same look, so only the affordance differs */
	.claim .text {
		flex: 1;
		min-width: 0;
		font: inherit;
		text-align: left;
		color: inherit;
		background: none;
		border: none;
		padding: 0;
	}
	.claim button.text {
		cursor: pointer;
	}
	.claim .text.edit {
		outline: none;
		border-radius: 5px;
	}
	.claim .text.edit:hover,
	.claim .text.edit:focus {
		box-shadow: inset 0 0 0 1px var(--input);
	}
	/* the ✕ removes the focused human quote (its claim too, if it was the last proof) */
	.claim .rm {
		flex: none;
		border: none;
		background: none;
		cursor: pointer;
		color: var(--muted-foreground);
		font-size: 12px;
		line-height: 1;
		padding: 2px 3px;
		border-radius: 5px;
	}
	.claim .rm:hover {
		color: #dc2626;
		background: color-mix(in oklch, #dc2626 12%, transparent);
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
	.claim .dots {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 19.5px; /* one text line — keeps the dots on the first line */
	}
	.claim .dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #16a34a;
		padding: 0;
		border: none;
		appearance: none;
		cursor: pointer;
	}
	.claim.against .dot {
		background: #dc2626;
	}
	/* a human-attached proof reads hollow — the judge's are solid (labelling data) */
	.claim .dot.userq {
		background: transparent;
		box-shadow: inset 0 0 0 1.5px #16a34a;
	}
	.claim.against .dot.userq {
		box-shadow: inset 0 0 0 1.5px #dc2626;
	}
	.claim .dot.on {
		box-shadow:
			0 0 0 2px var(--card),
			0 0 0 3px #16a34a;
	}
	.claim.against .dot.on {
		box-shadow:
			0 0 0 2px var(--card),
			0 0 0 3px #dc2626;
	}
	.claim .dot.userq.on {
		box-shadow:
			inset 0 0 0 1.5px #16a34a,
			0 0 0 2px var(--card),
			0 0 0 3px #16a34a;
	}
	.claim.against .dot.userq.on {
		box-shadow:
			inset 0 0 0 1.5px #dc2626,
			0 0 0 2px var(--card),
			0 0 0 3px #dc2626;
	}

	/* the proposed next action — the draft in the composer; the body is the human's to edit */
	.cta {
		margin: 0 18px 10px;
		padding-top: 8px;
		border-top: 1px solid var(--border);
		font-size: 13px;
		line-height: 1.55;
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
	/* the note toggle — small, beside Accept; the field unfolds below when asked for */
	.btn-note {
		flex: none;
		width: 44px;
		height: 44px;
		border-radius: 12px;
		border: 1px solid var(--input);
		background: var(--card);
		color: var(--muted-foreground);
		cursor: pointer;
		display: grid;
		place-items: center;
		transition:
			color 0.15s ease,
			background 0.15s ease;
	}
	.btn-note:hover {
		color: var(--foreground);
	}
	.btn-note.on {
		color: var(--foreground);
		background: var(--accent);
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
		border: none;
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
