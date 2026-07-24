// Inline ghost-text autocomplete for the draft fields — a Svelte attachment, wired once in
// OutputForm over whatever textareas the Output schema renders (so it is agent-agnostic). On a
// pause in typing it asks /api/complete for a continuation and paints it as dimmed ghost text
// behind the caret; Tab accepts, Esc or any edit dismisses. v1 offers a suggestion only when the
// caret sits at the END of the field (the "continue my draft" case) — the honest, flicker-free
// subset; mid-text insertion is deliberately out of scope until it earns its complexity.

interface Opts {
	id: string; // the Decision id — the endpoint's grounding handle
}

const DEBOUNCE = 150;
const MIN_CHARS = 2;

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
	let timer: ReturnType<typeof setTimeout> | undefined;
	let ctrl: AbortController | undefined;
	let seq = 0;

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

	const request = async () => {
		if (!atEnd() || el.value.trim().length < MIN_CHARS) return clear();
		const mine = ++seq;
		ctrl?.abort();
		ctrl = new AbortController();
		try {
			const res = await fetch("/api/complete", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: opts.id, field: fieldLabel(el), prefix: el.value, suffix: "" }),
				signal: ctrl.signal
			});
			if (!res.ok || mine !== seq) return;
			const { completion } = (await res.json()) as { completion?: string };
			if (mine !== seq) return; // a newer keystroke won
			suggestion = (completion ?? "").replace(/\s+$/, "");
			suggestion && atEnd() ? render() : clear();
		} catch {
			/* aborted or offline — simply no ghost */
		}
	};

	const onInput = () => {
		clear();
		if (timer) clearTimeout(timer);
		timer = setTimeout(request, DEBOUNCE);
	};
	const onKeydown = (e: KeyboardEvent) => {
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
		if (timer) clearTimeout(timer);
		ctrl?.abort();
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
