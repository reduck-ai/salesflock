<script lang="ts">
	// Screen two: one document, nothing else on screen. Title, prose, and a footer that answers the
	// only two questions a writer has — is my work safe, and are suggestions on.
	//
	// Saving has ONE implementation (`save`), reached three ways: ⌘S, a 15s heartbeat, and leaving the
	// page. It is dirty-gated and single-flight, so an idle document costs nothing and a slow Notion
	// write is never overlapped by the next tick.

	import { onMount } from "svelte";
	import { beforeNavigate } from "$app/navigation";
	import { EditorView, keymap, placeholder } from "@codemirror/view";
	import { EditorState } from "@codemirror/state";
	import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
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
			const res = await fetch(`/api/doc/${data.doc.id.replace(/-/g, "")}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
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
		return () => {
			clearInterval(beat);
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

	// NB: not named `state` — that would shadow the `$state` rune for the whole component.
	const saveState = $derived(saving ? "Saving…" : dirty ? "Unsaved" : savedAt ? `Saved ${savedAt}` : "Saved");
</script>

<svelte:head><title>{title || "Untitled"}</title></svelte:head>
<svelte:window onkeydown={hotkey} />

<main class="mx-auto max-w-3xl px-6 pb-24">
	<header class="appbar">
		<a class="back" href="/write">← Articles</a>
		<div class="right">
			{#if data.doc.status}<span class="badge">{data.doc.status}</span>{/if}
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
	<span class:dirty>{saveState}</span>
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
	.ext {
		font-size: 11.5px;
		color: var(--muted-foreground);
		text-decoration: none;
	}
	.ext:hover {
		color: var(--foreground);
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
	.statusbar .dirty {
		color: var(--foreground);
	}
	.hint {
		font-family: ui-monospace, monospace;
		letter-spacing: 0.02em;
	}
</style>
