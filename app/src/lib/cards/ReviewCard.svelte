<script lang="ts">
	// One evidenced judgment, read like a chat: the evidence is the document (one column,
	// window scroll), and the dock — the single interaction surface, styled like a composer —
	// floats at the bottom in two zones: PROPOSAL (the agent's proposal, headed by the Prompt's
	// framing, editable within its schema) first, then LEARNING (the claims that justify it, each
	// with one dot per proof, annotatable) — you decide, then read the reasoning.
	// The committed output IS the decision — one Confirm; there is no Reject (disagreeing is
	// editing the output). Every quote is highlighted in the evidence at all times, stance-
	// coloured and subtle, with its claim pinned in the right margin like a doc comment. One
	// cursor: click a claim, a dot, or a margin note — or press Tab/Shift+Tab — to focus a quote
	// and scroll it into view. ⏎ confirms, ←/→ navigate.
	// The human can also talk back at the reasoning: a comment on any claim, and a Notion-style
	// selection menu over the evidence to add a new claim (✓/✕) or attach the quote to an
	// existing one — all edits to a local copy of the statements; the judge's stay canonical and
	// the copy travels with the decision only when it differs.
	// Presentational: it owns the output/feedback edits (reset on remount) and emits the committed
	// output; meaning is the caller's.
	import Markdown from "$lib/components/Markdown.svelte";
	import OutputForm from "./OutputForm.svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { quoteAt, canonNormalize, quoteKey } from "$core/anchor";
	import { schemaError } from "$core/output";
	import type { EvidencedJudgment, Quote, Statement } from "./types";

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
		onjudge?: (
			committedOutput: Record<string, unknown> | undefined,
			feedback: string,
			reasoning?: Statement[]
		) => void;
		onnav?: (dir: -1 | 1) => void;
	} = $props();

	// seed from a saved draft when one exists, else from the judge's — so a checkpointed
	// review resumes where it was left. The judge's statements stay canonical on the prop
	// (provenance is read off `judgment.statements`, never this editable copy).
	let feedback = $state(judgment.draft?.feedback ?? "");
	let noting = $state(false); // the note field — closed on arrival; ⌘E toggles, the value seeds from the draft
	// the committed output — seeded from the judge's, edited in place; committing it IS the
	// decision (the card remounts per id, so it re-seeds from the judge's proposal)
	let output = $state<Record<string, unknown>>(structuredClone(judgment.output));
	// the human's editable copy of the reasoning — comments and added claims/quotes land here;
	// the judge's statements stay canonical on the prop (the card remounts per id)
	let statements = $state<Statement[]>(structuredClone(judgment.draft?.reasoning ?? judgment.statements));
	// the floating popover over a span — one primitive, two kinds: "add" (minted at mouseup over a
	// fresh selection, anchored-or-refuse) and "remove" (opened by clicking a user-added quote's
	// mark). x/top/bottom are the span's rect; the placement rule flips it to whichever side has room.
	let menu = $state<
		| { kind: "add"; quote: Quote | null; x: number; top: number; bottom: number }
		| { kind: "remove"; mi: number; x: number; top: number; bottom: number }
		| null
	>(null);
	// place the popover on the roomier side of the span and cap its height to fit — no measuring,
	// no flash, so the tall "attach" list is always fully on-screen (near the top it opens below).
	const MARGIN = 8;
	const place = $derived.by(() => {
		if (!menu) return null;
		const below = menu.top < window.innerHeight - menu.bottom;
		const maxH = Math.min(
			window.innerHeight * 0.4,
			(below ? window.innerHeight - menu.bottom : menu.top) - 16
		);
		const x = Math.min(Math.max(menu.x, MARGIN + 160), window.innerWidth - MARGIN - 160);
		return { below, top: below ? menu.bottom : menu.top, maxH, x };
	});
	let menuMode = $state<"acts" | "claim" | "attach">("acts");
	let stance = $state(true); // the new claim's stance, picked before its text is typed
	let claimText = $state("");
	let menuEl = $state<HTMLElement>();
	let activeMi = $state<number | null>(null); // the cursor: one quote (a mark index)
	let commenting = $state<number | null>(null); // the claim being annotated (distinct from the proof cursor, so Tab never opens a note)
	let evEl = $state<HTMLElement>();
	let dockEl = $state<HTMLElement>();

	// every quote in claim order, tagged with its statement index — the flat list the cursor
	// walks; a claim's marks are adjacent, so stepping reads claim by claim, proof by proof.
	// The output is not on the walk: it IS the editable proposal in the dock, not a claim to verify.
	const marks = $derived(statements.flatMap((s, i) => s.quotes.map((q) => ({ si: i, q }))));
	// the mark index of a statement's first quote — how the claim list addresses the cursor
	const miOf = (si: number) => statements.slice(0, si).reduce((n, s) => n + s.quotes.length, 0);
	const activeSi = $derived(activeMi === null ? null : marks[activeMi].si);

	// PLACEMENT — the one branch: a judgment with an `anchor` (code-computed — the span of the Input
	// field the output answers) attaches the composer BELOW that span; without one it floats in the
	// dock (a verdict about the whole subject). The anchor only SPLITS the evidence — it is never
	// itself highlighted (the field's `### header` already labels what's answered), so nothing new
	// enters the mark pipeline; `mi` is stamped explicitly so a split keeps global mark indices.
	const attached = $derived(!!judgment.anchor);
	const hls = $derived(marks.map((m, mi) => ({ ...m, mi })));
	// split the evidence at the first block boundary at/after the anchored span, so the composer sits
	// right beneath the post it answers. Block-aligned, so no quote straddles the cut; each half gets
	// the marks that fall in it (the lower half rebased), keeping global `mi` via the explicit field.
	const splitAt = $derived.by(() => {
		if (!attached) return 0;
		const nl = judgment.evidence.indexOf("\n\n", judgment.anchor!.end);
		return nl < 0 ? judgment.evidence.length : nl;
	});
	const before = $derived(attached ? judgment.evidence.slice(0, splitAt) : "");
	const after = $derived(attached ? judgment.evidence.slice(splitAt) : "");
	const marksBefore = $derived(hls.filter((m) => m.q.end <= splitAt));
	const marksAfter = $derived(
		hls
			.filter((m) => m.q.start >= splitAt)
			.map((m) => ({ ...m, q: { start: m.q.start - splitAt, end: m.q.end - splitAt } }))
	);

	// provenance, derived from the canonical prop — never stored. A claim or quote is the
	// human's iff it isn't in the judge's frozen judgment; the judge's stay immutable
	// labelling data, only the human's are editable. Same identity `diffStatements` uses.
	const original = $derived(
		new Map(judgment.statements.map((s) => [s.claim, new Set(s.quotes.map(quoteKey))]))
	);
	const isUserClaim = (claim: string) => !original.has(claim);
	const isUserQuote = (claim: string, q: Quote) => !original.get(claim)?.has(quoteKey(q));
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
			const mIdx = Number(m.getAttribute("data-mi"));
			m.classList.toggle("against", s ? !s.supporting : false);
			m.classList.toggle("userq", isUserQuote(statements[marks[mIdx].si].claim, marks[mIdx].q));
			m.classList.toggle("active", si !== null && m.getAttribute("data-si") === String(si));
			m.classList.toggle("current", mi !== null && m.getAttribute("data-mi") === String(mi));
			// a claim carrying the human's note reads gold — reading .comment here keeps this effect
			// reactive to note edits
			m.classList.toggle("noted", !!s?.comment?.trim());
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
	let anchors = $state<{ si: number; mi: number; top: number }[]>([]);
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
				const ms = [...el.querySelectorAll(`mark.hl[data-si="${si}"]`)].map((m) => ({
					si,
					mi: Number(m.getAttribute("data-mi")),
					top: m.getBoundingClientRect().top - base
				}));
				if (!ms.length) return [];
				// keep the whole mark, not just its top: which quote the pin sits beside IS where
				// clicking the note focuses (goto), so it must survive to the render.
				return ms.reduce((a, b) => (Math.abs(b.top - line) < Math.abs(a.top - line) ? b : a));
			})
			.sort((a, b) => a.top - b.top);
	});
	// the floor walk: each pin lands at its anchor, pushed down only past the one just above
	const notes = $derived.by(() => {
		let floor = 0;
		return anchors.map(({ si, mi, top }) => {
			const at = Math.max(top, floor);
			floor = at + (heights[si] ?? 0) + GAP;
			return { si, mi, top: at };
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
	// focus a claim without disturbing the cursor when it already sits inside it: clicking a
	// claim you're already reading keeps the exact quote Tab picked; only a different claim
	// jumps to its first proof. The one "focus a claim" gesture the dock and the margin share.
	const focusClaim = (si: number) => {
		if (activeSi !== si) goto(miOf(si));
	};
	// open a claim's note for editing, focused on the exact quote its pin sits beside (the mark
	// the anchor picked — the one in view), so editing the feedback never yanks the cursor to a
	// different proof of the claim. Reached from the pin's claim OR its comment; either edits.
	const editNote = (mi: number, si: number) => {
		goto(mi);
		commenting = si;
	};
	// Enter saves the note, Shift+Enter is a newline, Escape closes. Saving is just closing the
	// editor — the value is already bound — so the ⏎ key and the send button do the same thing.
	const onReplyKey = (e: KeyboardEvent) => {
		if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
			e.preventDefault();
			commenting = null;
		}
	};
	// the edited reasoning travels only when it differs from the judge's. Empty comments are
	// dropped, so an opened-then-abandoned field is not an edit.
	const reasoningEdit = (): Statement[] | undefined => {
		const edited = $state
			.snapshot(statements)
			.map(({ comment, ...s }) => (comment?.trim() ? { ...s, comment: comment.trim() } : s));
		return JSON.stringify(edited) !== JSON.stringify(judgment.statements) ? edited : undefined;
	};
	// the human is a judge too: the committed output is held to the same Prompt Output schema the
	// LLM's was (the shared gate). Confirm is inert while it violates — derived, no effect.
	const outputError = $derived(judgment.outputSchema ? schemaError(judgment.outputSchema, output) : null);
	// commit = the committed output (the decision), which advances the deck; save (no output) =
	// the same judgment with the decision withheld. The parent persists either way.
	const commit = () => {
		if (outputError) return;
		onjudge?.($state.snapshot(output), feedback.trim(), reasoningEdit());
	};
	export function save() {
		onjudge?.(undefined, feedback.trim(), reasoningEdit());
	}
	// ⌘⏎ confirm — driven page-level (the twin of ⌘S), so it fires even mid-note. Inert while
	// the selection popover is open (a commit would drop the in-progress claim); commit() owns
	// the schema gate.
	export function confirm() {
		if (!menu) commit();
	}
	// ⌘E toggle the note field — driven page-level (beside ⌘S/⌘⏎) so it fires even while typing.
	// The field auto-focuses on open via its own @attach.
	export function note() {
		noting = !noting;
	}

	// the selection menu opens on mouseup over a selection inside the evidence; the quote is
	// minted right away from the selection's POSITION — its offset in the evidence, disambiguated
	// against the visible text before it — so a repeated span resolves to the occurrence the
	// cursor is on, never the first. A selection with no source span (pure render chrome) shows a
	// hint instead of actions, never a guessed anchor.
	const onselect = (e: MouseEvent) => {
		if (menuEl?.contains(e.target as Node)) return;
		const s = window.getSelection();
		const text = s && !s.isCollapsed ? s.toString() : "";
		if (!text.trim() || !evEl || !evEl.contains(s!.anchorNode)) {
			menu = null;
			return;
		}
		const range = s!.getRangeAt(0);
		// the selection's approximate offset in canon-space = the visible text before it, normalized
		const pre = document.createRange();
		pre.selectNodeContents(evEl);
		pre.setEnd(range.startContainer, range.startOffset);
		const approx = canonNormalize(pre.toString()).length;
		const r = range.getBoundingClientRect();
		menuMode = "acts";
		claimText = "";
		menu = {
			kind: "add",
			quote: quoteAt(judgment.evidence, text, approx),
			x: r.left + r.width / 2,
			top: r.top,
			bottom: r.bottom
		};
	};
	const closeMenu = () => {
		menu = null;
		window.getSelection()?.removeAllRanges();
	};
	const addClaim = () => {
		const claim = claimText.trim();
		if (!claim || menu?.kind !== "add" || !menu.quote) return;
		statements.push({ claim, supporting: stance, quotes: [menu.quote] });
		closeMenu();
	};
	const attach = (si: number) => {
		if (menu?.kind === "add" && menu.quote) statements[si].quotes.push(menu.quote);
		closeMenu();
	};

	// the window scroll is shared chrome — each card starts at the top of its evidence
	$effect(() => window.scrollTo(0, 0));

	// ←/→ navigate, Tab / Shift+Tab step through proofs, ⌫ removes a focused user quote —
	// ignored while typing. (⌘⏎ confirm is page-level, beside ⌘S.)
	$effect(() => {
		const onkey = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
			// the popover owns the keys while open — Esc closes it; over a user quote ⌫ still removes
			if (menu) {
				if (e.key === "Escape") closeMenu();
				else if (menu.kind === "remove" && (e.key === "Backspace" || e.key === "Delete")) {
					e.preventDefault();
					removeFocused();
					menu = null;
				}
				return;
			}
			if (e.key === "ArrowRight") onnav?.(1);
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
		if (m && evEl?.contains(m)) {
			const mi = Number(m.getAttribute("data-mi"));
			activeMi = mi;
			// a user-added quote carries an inline remove popover, right at the highlight
			if (canRemove(mi)) {
				const r = m.getBoundingClientRect();
				menu = { kind: "remove", mi, x: r.left + r.width / 2, top: r.top, bottom: r.bottom };
			}
		} else if (!t.closest?.(".note-pin, .claim, .selmenu")) activeMi = null;
	}}
/>

<div class="page" class:attached>
	<div class="topmeta">
		<div class="rail" title={`${pos} / ${total}`}>
			<div class="fill" style={`width:${(pos / total) * 100}%`}></div>
		</div>
		<div class="meta">
			<span class="left">
				{pos} / {total}
				{#if judgment.hasFeedback}
					<Badge variant="outline" class="fb">feedback</Badge>
				{/if}
			</span>
			<span class="hint">
				<kbd>←</kbd><kbd>→</kbd> navigate · <kbd>Tab</kbd> proof · <kbd>⌘E</kbd> note · <kbd>⌘⏎</kbd> confirm
			</span>
		</div>
	</div>

	<div class="doc" bind:this={evEl}>
		{#if attached}
			<Markdown source={before} highlights={marksBefore} class="evidence" />
			<div class="dock attached" bind:this={dockEl}>{@render dockBody()}</div>
			{#if after.trim()}
				<Markdown source={after} highlights={marksAfter} class="evidence" />
			{/if}
		{:else}
			<Markdown source={judgment.evidence} highlights={hls} class="evidence" />
		{/if}
		<div class="gutter">
			{#each notes as n (n.si)}
				<div
					class="note-pin"
					class:against={!statements[n.si].supporting}
					class:on={activeSi === n.si}
					class:noted={!!statements[n.si].comment?.trim()}
					style={`top:${n.top}px`}
					bind:clientHeight={heights[n.si]}
				>
					<button onclick={() => editNote(n.mi, n.si)}>
						<span>{statements[n.si].claim}</span>
					</button>
					{#if commenting === n.si}
						<div class="composer">
							<textarea
								class="reply"
								rows="1"
								bind:value={statements[n.si].comment}
								placeholder="Reply…"
								{@attach (el: HTMLTextAreaElement) => el.focus()}
								onblur={() => (commenting = null)}
								onkeydown={(e) => onReplyKey(e)}></textarea>
							<button
								class="send"
								title="Save note (⏎)"
								aria-label="Save note"
								onmousedown={(e) => e.preventDefault()}
								onclick={() => (commenting = null)}
							>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2.2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg
								>
							</button>
						</div>
					{:else if statements[n.si].comment}
						<button class="cmt" title="Edit note" onclick={() => editNote(n.mi, n.si)}>
							<span class="cmt-text">{statements[n.si].comment}</span>
							<svg
								class="pencil"
								width="12"
								height="12"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
								><path
									d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"
								/></svg
							>
						</button>
					{/if}
				</div>
			{/each}
		</div>
	</div>
</div>

{#if !attached}
	<div class="veil"></div>
{/if}

{#if menu && place}
	<div
		class="selmenu"
		class:below={place.below}
		bind:this={menuEl}
		style={`left:${place.x}px; top:${place.top}px; --maxh:${place.maxH}px; transform: translate(-50%, ${place.below ? "10px" : "calc(-100% - 10px)"})`}
	>
		{#if menu.kind === "remove"}
			<button class="act rm-act" onclick={() => (removeFocused(), (menu = null))}>
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
					><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path
						d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
					/><line x1="10" x2="10" y1="11" y2="17" /><line x1="14" x2="14" y1="11" y2="17" /></svg
				>
				Remove quote
			</button>
		{:else if !menu.quote}
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

<!-- the floating dock — the composer for a verdict (no anchor); the attached case renders the
     same body in-flow below the answered span (see .doc above). One body, two placements. -->
{#if !attached}
	<div class="dock" bind:this={dockEl}>{@render dockBody()}</div>
{/if}

{#snippet dockBody()}
	<!-- PROPOSAL — the agent's proposal, headed by the Prompt's framing, editable within its
	     schema; committing it IS the decision. First, so you decide, then read the reasoning. -->
	<div class="proposal">
		{#if judgment.proposal}
			<h2 class="proposal-head">{judgment.proposal}</h2>
		{/if}
		<OutputForm schema={judgment.outputSchema} bind:value={output} id={judgment.id} />
		{#if outputError}
			<p class="err">{outputError}</p>
		{/if}
	</div>

	<!-- LEARNING — the judge's reasoning, annotatable; follows the proposal it justifies -->
	<div class="why">
		{#each statements as s, i (i)}
			<div
				class="claim"
				class:active={activeSi === i}
				class:against={!s.supporting}
				class:noted={!!s.comment?.trim()}
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
				<!-- the judge's claims are read-only labelling data; the human's own are editable -->
				{#if isUserClaim(s.claim)}
					<input
						class="text edit"
						aria-label="Edit claim"
						bind:value={statements[i].claim}
						onkeydown={(e) => (e.key === "Enter" || e.key === "Escape") && e.currentTarget.blur()}
					/>
				{:else}
					<button class="text" onclick={() => focusClaim(i)}>{s.claim}</button>
				{/if}
				<span class="dots">
					{#each s.quotes as q, j (j)}
						<button
							class="dot"
							class:on={activeMi === miOf(i) + j}
							class:userq={isUserQuote(s.claim, q)}
							aria-label="proof"
							onclick={() => goto(miOf(i) + j)}
						></button>
					{/each}
				</span>
			</div>
		{/each}
	</div>

	<div class="acts-wrap">
		<div class="acts">
			<button class="btn confirm" onclick={commit} disabled={!!outputError}>
				Confirm <kbd>⌘⏎</kbd>
			</button>
			<button
				class="btn-note"
				class:on={noting}
				title="Add a note (⌘E)"
				aria-expanded={noting}
				onclick={() => (noting = !noting)}
			>
				Note <kbd>⌘E</kbd>
			</button>
		</div>
		{#if noting}
			<input
				bind:value={feedback}
				class="note"
				placeholder="Optional note — why you (dis)agree"
				{@attach (el) => el.focus()}
				onkeydown={(e) => e.key === "Escape" && (noting = false)}
			/>
		{/if}
	</div>
{/snippet}

<style>
	.page {
		max-width: 720px;
		margin: 0 auto;
		padding: 0 4px 340px; /* deep bottom pad: last evidence clears the dock */
	}
	/* attached mode: the composer is in flow, so no floating dock to clear — trim the deep pad */
	.page.attached {
		padding-bottom: 40px;
	}
	/* the card's half of the top bar — progress + key hints — sticks flush beneath the app
	   header, so the whole band stays put while the evidence scrolls under it */
	.topmeta {
		position: sticky;
		top: var(--topbar);
		z-index: 15;
		background: var(--background);
		padding-top: 8px;
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
	.meta .left {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	/* the feedback marker — a subtle gold outline, the same "human touched this" language as .noted */
	.meta :global(.fb) {
		border-color: color-mix(in oklch, #d97706 55%, var(--border));
		color: #d97706;
		font-family: ui-monospace, monospace;
		letter-spacing: 0.04em;
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
		width: 300px;
	}
	.note-pin {
		position: absolute;
		width: 100%;
		/* a thread: the claim leads, the note replies — entries separated by this gap, not a
		   divider line; the card (border + stance bar) is the unit, independent of siblings */
		display: flex;
		flex-direction: column;
		gap: 8px;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted-foreground);
		background: var(--card);
		border: 1px solid var(--border);
		border-left: 2.5px solid #16a34a;
		border-radius: 10px;
		padding: 8px 10px;
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
	/* the reply composer — the dock's bordered note field, scoped to the pin: a rounded box
	   holding a note that grows with its text (field-sizing) and a send button. ⏎ or the send
	   button saves; the box rings on focus. */
	.note-pin .composer {
		display: flex;
		align-items: flex-end;
		gap: 4px;
		padding: 3px 3px 3px 0;
		border: 1px solid var(--input);
		border-radius: 9px;
		background: var(--card);
	}
	.note-pin .composer:focus-within {
		border-color: var(--ring);
		box-shadow: 0 0 0 3px color-mix(in oklch, var(--ring) 30%, transparent);
	}
	.note-pin .reply {
		flex: 1;
		min-width: 0;
		padding: 4px 0 4px 9px;
		border: none;
		background: none;
		font: inherit;
		font-size: 12px;
		line-height: 1.45;
		color: var(--foreground);
		outline: none;
		resize: none;
		field-sizing: content;
	}
	.note-pin .reply::placeholder {
		color: var(--muted-foreground);
	}
	/* send/save — a small round icon button, muted until hovered; overrides the pin's block
	   button reset so it stays a compact square, not a full-width row */
	.note-pin .send {
		flex: none;
		width: 24px;
		height: 24px;
		display: grid;
		place-items: center;
		border-radius: 7px;
		color: var(--muted-foreground);
		cursor: pointer;
	}
	.note-pin .send:hover {
		color: var(--foreground);
		background: var(--accent);
	}
	/* the human's note — a reply entry in the thread, a subtle bubble rather than a divided-off
	   line, so it reads as its own unit. Clicking it reopens the composer; a pencil fades in on
	   hover to signal that. */
	.note-pin .cmt {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		padding: 6px 8px;
		border: none;
		border-radius: 8px;
		background: var(--muted);
		font: inherit;
		font-size: 12px;
		color: var(--foreground);
		text-align: left;
		cursor: pointer;
	}
	.note-pin .cmt-text {
		flex: 1;
		min-width: 0;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.note-pin .pencil {
		flex: none;
		margin-top: 2px;
		color: var(--muted-foreground);
		opacity: 0;
		transition: opacity 0.15s ease;
	}
	.note-pin .cmt:hover .pencil {
		opacity: 1;
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
	/* a note on this claim reads gold — wins over stance/active (placed last, matched specificity) */
	.note-pin.noted {
		border-left-color: #d97706;
	}
	.note-pin.noted.on {
		border-color: color-mix(in oklch, #d97706 45%, var(--border));
		border-left-color: #d97706;
	}
	@media (max-width: 1360px) {
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

	/* the span popover — Notion-style, floated at the highlight; the transform (which side it
	   opens on) is set inline by the placement rule, so it always lands fully on-screen */
	.selmenu {
		position: fixed;
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
	/* the inline remove — a trash icon + label; reddens on hover like the intent it carries */
	.selmenu .rm-act {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.selmenu .rm-act:hover {
		color: #dc2626;
		background: color-mix(in oklch, #dc2626 12%, transparent);
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
		max-height: var(--maxh, 40vh); /* capped to the room on the chosen side, then scrolls */
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
	/* attached — the same composer body, but in the document flow directly below the span it
	   answers: static (nothing overlaid), solid card (no blur, nothing behind it), full column. */
	.dock.attached {
		position: static;
		inset: auto;
		max-width: none;
		margin: 18px 0;
		background: var(--card);
		backdrop-filter: none;
	}

	/* PROPOSAL — the dock's top zone: the Prompt's framing over the editable output */
	.proposal {
		padding: 14px 18px 12px;
	}
	/* the framing header — the card's title, in the dock's uppercase-mono label language but
	   foregrounded so it reads as the heading, not a field label */
	.proposal-head {
		margin: 0 0 11px;
		font-family: ui-monospace, monospace;
		font-size: 11.5px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--foreground);
	}

	/* the claims — LEARNING, below the proposal they justify; one dot per proof, the cursor
	   lives in the dots */
	.why {
		padding: 12px 10px 8px;
		border-top: 1px solid var(--border);
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
	/* a claim carrying the human's note: a gold left bar, same language as the evidence marks */
	.claim.noted {
		box-shadow: inset 2px 0 0 #d97706;
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
	/* a human-added proof reads blue — provenance over stance (matches the evidence highlight) */
	.claim .dot.userq,
	.claim.against .dot.userq {
		background: #2563eb;
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
	.claim .dot.userq.on,
	.claim.against .dot.userq.on {
		box-shadow:
			0 0 0 2px var(--card),
			0 0 0 3px #2563eb;
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
	/* the note toggle — "Note" beside Confirm; the field unfolds below when asked for (⌘E) */
	.btn-note {
		flex: none;
		height: 44px;
		padding: 0 14px;
		border-radius: 12px;
		border: 1px solid var(--input);
		background: var(--card);
		color: var(--muted-foreground);
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 13.5px;
		font-weight: 600;
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
	.btn-note kbd {
		font-family: ui-monospace, monospace;
		font-size: 10.5px;
		font-weight: 600;
		padding: 2px 5px;
		border-radius: 5px;
		border: 1px solid var(--border);
		color: var(--muted-foreground);
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
	.btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
		filter: none;
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
	.btn.confirm {
		background: #16a34a;
	}
	/* the schema violation — why Confirm is inert; the shared gate's own message */
	.err {
		margin: 6px 2px 0;
		font-size: 12px;
		line-height: 1.4;
		color: #dc2626;
	}

	@media (prefers-reduced-motion: reduce) {
		* {
			transition: none !important;
		}
	}
</style>
