<script lang="ts">
	// Screen two: one document, nothing else on screen. Title, prose, and a footer that answers the
	// only two questions a writer has — is my work safe, and are suggestions on.
	//
	// Saving has ONE implementation (`save`), reached three ways: ⌘S, a 15s heartbeat, and leaving the
	// page. It is dirty-gated and single-flight, so an idle document costs nothing and a slow Notion
	// write is never overlapped by the next tick.
	//
	// Text arrives the same way: ONE implementation (`apply`), reached two ways — "Sync ↓" (a re-read,
	// which is also how an edit made in Notion gets here) and the live channel (a save by anyone else,
	// in practice `sflock docs push`). Applying is a single CodeMirror transaction, so the words it
	// replaces are one ⌘Z away — that undo IS the safety net, which is why an incoming version needs no
	// banner to accept.

	import { onMount } from "svelte";
	import { dev } from "$app/environment";
	import { beforeNavigate } from "$app/navigation";
	import { EditorView, keymap, placeholder } from "@codemirror/view";
	import { EditorState } from "@codemirror/state";
	import { defaultKeymap, history, historyKeymap, isolateHistory } from "@codemirror/commands";
	import { markdown } from "@codemirror/lang-markdown";
	import { ghost } from "$lib/writer/ghost";
	import { enabled as autocompleteEnabled } from "$lib/autocomplete/engine";

	let { data } = $props();

	// The loaded document seeds the editor and is then the EDITOR's, not the loader's: this route is
	// one document, so `data` never changes under it. Reading the initial value is the intent.
	// svelte-ignore state_referenced_locally
	let title = $state(data.doc.title);
	// svelte-ignore state_referenced_locally
	let body = data.doc.markdown; // not $state: CodeMirror owns the text, this mirrors it for saving
	let host = $state<HTMLDivElement>();
	let view: EditorView | undefined;

	let dirty = $state(false);
	let saving = $state(false);
	let savedAt = $state<string | null>(null);
	let syncedAt = $state<string | null>(null);
	let synced = $state(false); // an arrival JUST landed — the dot's brief accent, cleared below
	let syncFlash: ReturnType<typeof setTimeout> | undefined;
	const SYNC_FLASH = 4000;

	// This tab's identity for the round trip. The server echoes it on the event, so a tab ignores its
	// OWN save coming back — otherwise every autosave would re-apply the same text and cost the writer
	// their caret. Anything without a token (a push) is by definition someone else's, so it applies.
	const client = crypto.randomUUID();
	// This route is ONE document, so the id never changes under it (same reason `body` reads `data` once).
	// svelte-ignore state_referenced_locally
	const endpoint = `/api/doc/${data.doc.id.replace(/-/g, "")}`;
	// Seeded from the editor once it exists (the extension remembers the choice across sessions), then
	// kept current by its `onstate`. Defaulting to true here would make the footer lie on load.
	let suggesting = $state(false);

	const AUTOSAVE = 15_000;

	// The autocomplete's grounding. One stable object, mutated in place: the engine spreads it at
	// REQUEST time, so retitling a draft immediately grounds the next suggestion — no re-created
	// extension, no editor rebuild.
	// svelte-ignore state_referenced_locally
	const ground: { title?: string } = { title: data.doc.title };
	$effect(() => {
		ground.title = title;
	});

	// The one save. Dirty-gated (an untouched document is already saved) and single-flight (`saving`),
	// so the heartbeat can fire freely without stacking writes. `dirty` is cleared BEFORE the request
	// so an edit made mid-flight is correctly seen as new work rather than swallowed by this save.
	const save = async () => {
		if (!dirty || saving) return;
		saving = true;
		dirty = false;
		try {
			const res = await fetch(endpoint, {
				method: "PUT",
				headers: { "content-type": "application/json", "x-writer-client": client },
				body: JSON.stringify({ title, markdown: body })
			});
			if (!res.ok) throw new Error(String(res.status));
			savedAt = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
		} catch {
			dirty = true; // the work is NOT safe — say so instead of showing a false "saved"
		} finally {
			saving = false;
		}
	};

	// apply(d) — the incoming document becomes this one. ONE transaction replacing the whole text, which
	// is what makes it a single undo step (the writer's own words are never gone, just behind ⌘Z), and
	// the caret is put back at the offset it held, clamped. `dirty = false` comes AFTER the dispatch on
	// purpose: the update listener runs inside it and would otherwise flag the incoming text as unsaved
	// work — and the next heartbeat would write back what we were just given.
	const apply = (d: { title?: string; markdown?: string }) => {
		if (!view || d.markdown === undefined) return;
		const head = view.state.selection.main.head;
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: d.markdown },
			selection: { anchor: Math.min(head, d.markdown.length) },
			// `isolateHistory` is what makes "one ⌘Z" true. Without it the history groups changes made
			// close together in time, so an arrival that lands seconds after the writer's last keystroke
			// merges with it — measured: one undo reverted the push AND the sentence typed before it.
			// Isolated, the arrival is its own event: the first undo gives back exactly what was there.
			annotations: isolateHistory.of("full")
		});
		if (d.title !== undefined) title = d.title;
		dirty = false;
		syncedAt = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
		// The dot marks an arrival for a few seconds, then goes back to being the save light: a document
		// that synced ten minutes ago is just a saved document.
		synced = true;
		clearTimeout(syncFlash);
		syncFlash = setTimeout(() => (synced = false), SYNC_FLASH);
	};

	// The manual trigger: re-read the stored document and apply it. The one way to pick up an edit made
	// in Notion, and the fallback whenever the live channel isn't there (it only runs in dev).
	let pulling = $state(false);
	const pull = async () => {
		if (pulling) return;
		pulling = true;
		try {
			const res = await fetch(endpoint, { headers: { accept: "application/json" } });
			if (!res.ok) throw new Error(String(res.status));
			apply((await res.json()) as { title: string; markdown: string });
		} catch {
			syncedAt = null; // say nothing rather than claim a sync that failed
		} finally {
			pulling = false;
		}
	};

	onMount(() => {
		view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: body,
				extensions: [
					history(),
					keymap.of([...defaultKeymap, ...historyKeymap]),
					markdown(),
					placeholder("Start writing…"),
					EditorView.lineWrapping,
					// The ghost extension goes AFTER the default keymap so its Tab/Esc win.
					ghost({ ground, onstate: (on) => (suggesting = on) }),
					EditorView.updateListener.of((u) => {
						if (!u.docChanged) return;
						body = u.state.doc.toString();
						dirty = true;
					}),
					EditorView.theme({
						"&": { fontSize: "16px" },
						// The font belongs on the SCROLLER: CodeMirror's base theme sets monospace there, so
						// `inherit` on .cm-content alone would only inherit that monospace back. This is
						// long-form prose, so it reads in the app's own typeface.
						".cm-scroller": { fontFamily: "inherit" },
						".cm-content": {
							padding: "8px 0",
							lineHeight: "1.7",
							// The caret is the NATIVE one (no drawSelection extension), and CodeMirror's base
							// theme defaults it to black — invisible on a dark page. Reading the app's own
							// token instead makes it follow light/dark (routes/layout.css redefines
							// --foreground under .dark) with no theme flag to keep in sync.
							caretColor: "var(--foreground)"
						},
						"&.cm-focused": { outline: "none" },
						".cm-line": { padding: "0" }
					})
				]
			})
		});
		suggesting = autocompleteEnabled();
		const beat = setInterval(save, AUTOSAVE);
		// The live channel — the same URL as `pull`, streaming because EventSource asks for
		// text/event-stream. Dev only, exactly where the push knob exists: on the deployed app it would
		// hold a serverless invocation open to hear an event that can never be published there. Its own
		// reconnection is the browser's.
		const live = dev ? new EventSource(endpoint) : null;
		if (live)
			live.onmessage = (e) => {
				const d = JSON.parse(e.data) as { title?: string; markdown?: string; from?: string };
				if (d.from !== client) apply(d);
			};
		return () => {
			clearInterval(beat);
			clearTimeout(syncFlash);
			live?.close();
			view?.destroy();
		};
	});

	// Leaving with unsaved work would lose it silently — so the same save runs first.
	beforeNavigate(() => void save());

	// ⌘S / Ctrl+S — the manual save, on the window so it fires wherever the caret is (the editor
	// included). The browser's own "save page" is not what a writer means by ⌘S here.
	const hotkey = (e: KeyboardEvent) => {
		if ((e.metaKey || e.ctrlKey) && e.key === "s") {
			e.preventDefault();
			void save();
		}
	};

	// The footer says it with a DOT, not a sentence: a writer glances at it, and prose in the corner of
	// a prose editor reads as content. The words live in its tooltip (and its aria-label, so the state
	// is not colour-only) — that is the whole indicator.
	// NB: not named `state` — that would shadow the `$state` rune for the whole component.
	const saveState = $derived(
		saving
			? "Saving…"
			: dirty
				? "Unsaved changes"
				: synced
					? `Synced from Claude ${syncedAt} · ⌘Z to go back`
					: savedAt
						? `Saved ${savedAt}`
						: "Saved"
	);
</script>

<svelte:head><title>{title || "Untitled"}</title></svelte:head>
<svelte:window onkeydown={hotkey} />

<main class="mx-auto max-w-3xl px-6 pb-24">
	<header class="appbar">
		<a class="back" href="/write">← Articles</a>
		<div class="right">
			{#if data.doc.status}<span class="badge">{data.doc.status}</span>{/if}
			<button class="ext" onclick={pull} disabled={pulling} title="Re-read the stored document">
				{pulling ? "Syncing…" : "Sync ↓"}
			</button>
			<a class="ext" href={data.doc.url} target="_blank" rel="noreferrer">Notion ↗</a>
		</div>
	</header>

	<input
		class="title"
		bind:value={title}
		oninput={() => (dirty = true)}
		placeholder="Title"
		aria-label="Title"
	/>

	<div class="editor" bind:this={host}></div>
</main>

<footer class="statusbar">
	<span class="dot" class:dirty class:saving class:synced title={saveState} aria-label={saveState} role="status"
	></span>
	<span class="hint">
		Autocomplete <strong>{suggesting ? "on" : "off"}</strong> · ⇧⇥ toggle · ⇥ accept · ⌘S save
	</span>
</footer>

<style>
	.appbar {
		position: sticky;
		top: 0;
		z-index: 20;
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: var(--topbar);
		background: var(--background);
	}
	.back {
		color: var(--muted-foreground);
		text-decoration: none;
		font-size: 1rem;
	}
	.back:hover {
		color: var(--foreground);
	}
	.right {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.badge {
		padding: 2px 7px;
		border-radius: 6px;
		background: var(--secondary);
		color: var(--secondary-foreground);
		font-size: 10.5px;
		font-weight: 550;
	}
	/* Both appbar affordances read the same, whether they navigate (Notion ↗) or act (Sync ↓) — so the
	   button carries no chrome of its own beyond the reset. */
	.ext {
		font-size: 11.5px;
		color: var(--muted-foreground);
		text-decoration: none;
		background: none;
		border: none;
		padding: 0;
		font-family: inherit;
		cursor: pointer;
	}
	.ext:hover:not(:disabled) {
		color: var(--foreground);
	}
	.ext:disabled {
		cursor: default;
		opacity: 0.6;
	}
	.title {
		width: 100%;
		border: none;
		background: transparent;
		color: var(--foreground);
		font: inherit;
		font-size: 30px;
		font-weight: 700;
		line-height: 1.25;
		padding: 8px 0;
		margin-bottom: 4px;
	}
	.title:focus {
		outline: none;
	}
	.title::placeholder {
		color: var(--muted-foreground);
		opacity: 0.5;
	}
	.editor {
		font-size: 16px;
	}
	.editor :global(.cm-editor) {
		background: transparent;
	}
	.editor :global(.cm-placeholder) {
		color: var(--muted-foreground);
		opacity: 0.5;
	}
	/* No rules for .cm-cursor / .cm-selectionBackground: those elements exist only under the
	   drawSelection extension, which this editor does not load — the caret and the selection are the
	   browser's own. The caret is coloured in the theme above; native selection needs nothing. */
	/* the one persistent chrome: is my work safe, are suggestions on */
	.statusbar {
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 7px 16px;
		background: var(--background);
		border-top: 1px solid var(--border);
		font-size: 11.5px;
		color: var(--muted-foreground);
	}
	/* The save light: one 6px dot. Resting (saved) it is barely there; unsaved work fills it, a save in
	   flight breathes, and an arrival accents it for a moment. Every state is also in the tooltip and the
	   aria-label, so nothing here is colour-only. */
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--muted-foreground);
		opacity: 0.45;
		transition:
			background 0.2s,
			opacity 0.2s;
	}
	.dot.dirty {
		background: var(--foreground);
		opacity: 0.9;
	}
	.dot.saving {
		background: var(--foreground);
		opacity: 0.6;
		animation: breathe 1.2s ease-in-out infinite;
	}
	.dot.synced {
		background: var(--primary);
		opacity: 1;
	}
	@keyframes breathe {
		50% {
			opacity: 0.2;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.dot.saving {
			animation: none;
		}
	}
	.hint {
		font-family: ui-monospace, monospace;
		letter-spacing: 0.02em;
	}
</style>
