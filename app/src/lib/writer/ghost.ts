// Ghost-text autocomplete as a CodeMirror extension — the Writer's painter, over the SAME engine the
// Decisions textareas use ($lib/autocomplete/engine): the pause, the abort and the supersede check
// are not restated here, only the drawing and the keys.
//
// Two things CodeMirror gives that a textarea could not, so the Writer takes them:
//   - a real caret position in a document, so the suggestion is grounded in the text on BOTH sides
//     (the textarea version only completes at the very end — it has no honest mid-text story);
//   - decorations, so the ghost is a widget IN the document flow rather than a mirrored overlay
//     kept in sync by copying computed styles.
//
// Keys: Tab accepts, Esc dismisses, Shift-Tab toggles the whole feature (remembered in localStorage —
// a writer who turns suggestions off means it for the session, not for one keystroke).

import { EditorView, Decoration, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { createCompleter, toggle } from "$lib/autocomplete/engine";

// The one piece of state: the suggestion currently offered, and where it sits. Null = no ghost.
// The on/off flag is deliberately NOT here — it is the engine's (shared with the Decisions painter),
// so this file has no field, effect or storage key for it.
interface Ghost {
	text: string;
	pos: number;
}
const setGhost = StateEffect.define<Ghost | null>();

// The ghost itself — an inline widget of muted text. `ignoreEvent: false` lets a click through to the
// document beneath, so the ghost never traps the caret.
class GhostWidget extends WidgetType {
	constructor(readonly text: string) {
		super();
	}
	eq(other: GhostWidget) {
		return other.text === this.text;
	}
	toDOM() {
		const span = document.createElement("span");
		span.className = "cm-ghost";
		span.textContent = this.text;
		return span;
	}
	ignoreEvent() {
		return false;
	}
}

const ghostField = StateField.define<Ghost | null>({
	create: () => null,
	update(value, tr) {
		// An explicit effect always wins (that is how a suggestion arrives or is dismissed). Otherwise
		// any edit or caret move invalidates a suggestion made for the old position — never remap it:
		// text the writer has since typed is exactly what the suggestion no longer accounts for, and
		// the request for the new position is already in flight (the update listener below).
		for (const e of tr.effects) if (e.is(setGhost)) return e.value;
		return tr.docChanged || tr.selection ? null : value;
	},
	provide: (f) =>
		EditorView.decorations.from(f, (g): DecorationSet =>
			g ? Decoration.set([Decoration.widget({ widget: new GhostWidget(g.text), side: 1 }).range(g.pos)]) : Decoration.none
		)
});

// accept — insert the ghost at its position and put the caret after it. The ghost is dropped by the
// same transaction (docChanged clears the field), so there is no window where it shows twice.
const accept = (view: EditorView): boolean => {
	const g = view.state.field(ghostField);
	if (!g) return false;
	view.dispatch({
		changes: { from: g.pos, insert: g.text },
		selection: { anchor: g.pos + g.text.length }
	});
	return true;
};

const dismiss = (view: EditorView): boolean => {
	if (!view.state.field(ghostField)) return false;
	view.dispatch({ effects: setGhost.of(null) });
	return true;
};

// ghost({ground, onstate}) — the extension. `ground` is what /api/complete keys the grounding on (the
// Writer sends its document title); `onstate` reports the enabled flag so the page can put it in the
// footer without reaching into editor internals.
export const ghost = (opts: { ground: Record<string, string | undefined>; onstate?: (on: boolean) => void }): Extension => {
	const completer = createCompleter({ ground: opts.ground, minChars: 8 });

	// ⇧⇥ — flip the shared preference, drop the ghost on screen, and abandon the one in flight (cancel
	// supersedes it, so a reply that is already on the wire can't paint after you turned it off).
	const flip = (view: EditorView): boolean => {
		const on = toggle();
		completer.cancel();
		view.dispatch({ effects: setGhost.of(null) });
		opts.onstate?.(on);
		return true;
	};

	return [
		ghostField,
		// Tab/Esc must beat the default indent + close bindings, so this keymap goes in front.
		keymap.of([
			{ key: "Tab", run: accept },
			{ key: "Escape", run: dismiss },
			{ key: "Shift-Tab", run: flip, preventDefault: true }
		]),
		EditorView.updateListener.of((update) => {
			if (!update.docChanged && !update.selectionSet) return;
			const view = update.view;
			const pos = view.state.selection.main.head;
			// A selection is a choice about existing text, not an invitation to add more.
			if (!view.state.selection.main.empty) return completer.cancel();
			const doc = view.state.doc;
			void completer
				.suggest({ prefix: doc.sliceString(0, pos), suffix: doc.sliceString(pos) })
				.then((text) => {
					// The caret must still be where the suggestion was asked for — otherwise it would
					// appear at a position it does not describe. (Nothing checks the enabled flag here:
					// suggest returns null when it is off, and `flip` cancels whatever was in flight.)
					if (!text || view.state.selection.main.head !== pos) return;
					view.dispatch({ effects: setGhost.of({ text, pos }) });
				});
		}),
		EditorView.theme({
			".cm-ghost": { color: "var(--muted-foreground)", opacity: "0.75" }
		})
	];
};
