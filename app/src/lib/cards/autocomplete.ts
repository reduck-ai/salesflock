// Inline ghost-text autocomplete for the draft fields — a Svelte attachment, wired once in
// OutputForm over whatever textareas the Output schema renders (so it is agent-agnostic). On a
// pause in typing it asks the shared engine ($lib/autocomplete/engine) for a continuation and paints
// it as dimmed ghost text behind the caret; Tab accepts, Esc or any edit dismisses. v1 offers a
// suggestion only when the caret sits at the END of the field (the "continue my draft" case) — the
// honest, flicker-free subset; mid-text insertion is deliberately out of scope until it earns its
// complexity. ⇧⇥ turns suggestions off and on, the same key the Writer's editor uses — the preference
// itself is the engine's, so both surfaces read and write ONE flag.
//
// This file is now purely the TEXTAREA PAINTER: the debounce/abort/supersede race lives once in the
// engine, shared with the Writer's CodeMirror ghost.

import { createCompleter, enabled, toggle } from "$lib/autocomplete/engine";

interface Opts {
	id: string; // the Decision id — the endpoint's grounding handle
}

// The field's human label, best-effort — only used to frame the prompt ("editing the X field").
const fieldLabel = (el: HTMLTextAreaElement): string | undefined =>
	el.labels?.[0]?.textContent?.trim() ||
	el.closest(".sjsf-field, fieldset")?.querySelector(".sjsf-label, label")?.textContent?.trim() ||
	undefined;

// A transparent mirror sitting exactly over the textarea: the real text shows through from the
// textarea beneath, and we append the suggestion as a muted span so it lands right at the caret.
const STYLE_KEYS = [
	"font",
	"letterSpacing",
	"lineHeight",
	"padding",
	"borderWidth",
	"borderStyle",
	"textAlign",
	"textIndent",
	"wordSpacing",
	"whiteSpace",
	"overflowWrap"
] as const;

const attachTo = (el: HTMLTextAreaElement, opts: Opts): (() => void) => {
	const parent = el.parentElement;
	if (!parent) return () => {};
	if (getComputedStyle(parent).position === "static") parent.style.position = "relative";

	const ghost = document.createElement("div");
	ghost.setAttribute("aria-hidden", "true");
	Object.assign(ghost.style, {
		position: "absolute",
		pointerEvents: "none",
		overflow: "hidden",
		boxSizing: "border-box",
		whiteSpace: "pre-wrap",
		wordBreak: "break-word",
		color: "transparent",
		borderColor: "transparent",
		background: "transparent",
		margin: "0"
	});
	parent.appendChild(ghost);

	let suggestion = "";
	const completer = createCompleter({ ground: { id: opts.id } });

	// The state signal: `data-autocomplete` on the field itself, styled in OutputForm (a dashed border
	// means suggestions are off). The attribute is the state, the CSS is the look — so the field reads
	// the theme's tokens and this file decides no colours.
	const signal = (on: boolean) => (el.dataset.autocomplete = on ? "on" : "off");
	signal(enabled());

	const atEnd = () =>
		el.selectionStart === el.selectionEnd && el.selectionStart === el.value.length;

	const clear = () => {
		suggestion = "";
		ghost.textContent = "";
	};

	const render = () => {
		const cs = getComputedStyle(el);
		for (const k of STYLE_KEYS) ghost.style[k] = cs[k];
		ghost.style.left = `${el.offsetLeft}px`;
		ghost.style.top = `${el.offsetTop}px`;
		ghost.style.width = `${el.offsetWidth}px`;
		ghost.style.height = `${el.offsetHeight}px`;
		ghost.textContent = "";
		const sug = document.createElement("span");
		sug.textContent = suggestion;
		sug.style.color = "var(--muted-foreground)";
		ghost.append(document.createTextNode(el.value), sug);
		ghost.scrollTop = el.scrollTop;
	};

	// The engine owns the pause, the abort and the supersede check; this only decides whether the
	// answer is still paintable (the caret may have left the end while it was in flight).
	const onInput = async () => {
		clear();
		if (!atEnd()) return completer.cancel();
		const completion = await completer.suggest({ prefix: el.value, field: fieldLabel(el) });
		if (!completion || !atEnd()) return clear();
		suggestion = completion;
		render();
	};
	const onKeydown = (e: KeyboardEvent) => {
		// ⇧⇥ first, and before the no-suggestion bail: turning suggestions back ON is exactly the case
		// where no ghost is showing, so gating this on `suggestion` would make the switch one-way.
		if (e.key === "Tab" && e.shiftKey) {
			e.preventDefault();
			signal(toggle());
			completer.cancel(); // supersede a reply in flight — it must not paint after being turned off
			clear();
			return;
		}
		if (!suggestion) return;
		if (e.key === "Tab") {
			e.preventDefault();
			const v = el.value + suggestion;
			el.value = v;
			el.setSelectionRange(v.length, v.length);
			clear();
			el.dispatchEvent(new Event("input", { bubbles: true })); // let the @sjsf binding pick it up
		} else if (e.key === "Escape") {
			e.preventDefault();
			clear();
		} else if (e.key.length === 1) {
			clear(); // typing over the ghost dismisses it; onInput schedules the next request
		}
	};
	const onCaret = () => suggestion && !atEnd() && clear();
	const onScroll = () => suggestion && (ghost.scrollTop = el.scrollTop);

	el.addEventListener("input", onInput);
	el.addEventListener("keydown", onKeydown);
	el.addEventListener("click", onCaret);
	el.addEventListener("keyup", onCaret);
	el.addEventListener("blur", clear);
	el.addEventListener("scroll", onScroll);
	const ro = new ResizeObserver(() => suggestion && render());
	ro.observe(el);

	return () => {
		completer.cancel();
		ro.disconnect();
		el.removeEventListener("input", onInput);
		el.removeEventListener("keydown", onKeydown);
		el.removeEventListener("click", onCaret);
		el.removeEventListener("keyup", onCaret);
		el.removeEventListener("blur", clear);
		el.removeEventListener("scroll", onScroll);
		ghost.remove();
	};
};

// The attachment: apply to every textarea under the container now and as the form (re)renders,
// returning a cleanup that tears them all down. `{@attach autocomplete({ id })}` on the form div.
export const autocomplete = (opts: Opts) => (container: HTMLElement): (() => void) => {
	const live = new Map<HTMLTextAreaElement, () => void>();
	const wire = () =>
		container.querySelectorAll<HTMLTextAreaElement>("textarea").forEach((t) => {
			if (!live.has(t)) live.set(t, attachTo(t, opts));
		});
	wire();
	const mo = new MutationObserver(wire);
	mo.observe(container, { childList: true, subtree: true });
	return () => {
		mo.disconnect();
		live.forEach((c) => c());
		live.clear();
	};
};
