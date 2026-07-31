// The Writer's documents, read-only — the third thing `sflock` inspects, beside an agent's
// `decisions` and `prompts`. A doc is a page of one Notion data source ("Content to post"): the row
// carries the metadata, the page BODY carries the prose (README #5 — prose is authored, not
// compiled), which is exactly what the review app's Writer (`app/src/lib/server/writer.ts`) edits.
// This is the READ half of that surface for an agent working in the terminal.
//
// Nothing here re-implements the Writer: the READS are the Store seam — `queryAll` for the list,
// `get` + `body` for one doc — so a CLI read and the app's read render the same markdown (both end
// in the shared codec's `bodyOf`).
//
// The WRITE takes the other path, deliberately: `push` calls the app's own save sink
// (`PUT /api/doc/<id>`), the very endpoint the editor calls. Two reasons, and they are the whole
// design — the document gets ONE write path (append-then-wipe lives in one place, the app's
// writer.ts), and the app publishes what it saved to the editor that is open, so a push lands on
// screen instead of waiting for a reload. Hence: read from the store (works with no app running —
// that is the CLI's value), write through the app (so the editor sees it). Loud when the app is
// down, never a Notion-direct fallback: "did my editor get it?" must have one answer.
//
// The data source is NOT an agent's model: it is one shared writing table, so it has no home in any
// `config.ts`. It is pinned here the way every agent pins its own tables' ids — in code, so the tool
// runs with no setup — with NOTION_WRITER_DS as the override (the same variable the app reads, for a
// fork or a second workspace).

import { getStore, queryAll } from "./stores/index.js";
import { idOf, pageUrl } from "./stores/notion.js";

const store = getStore("notion");

const WRITER_DS = "3454d7b7-884c-80fc-b388-000b012a8543"; // "Content to post"
const ds = (): string => process.env.NOTION_WRITER_DS || WRITER_DS;

// Every row, whatever the table's properties are: the title in this database is optional, so no
// property is assumed beyond the one the filter needs. `Name` is its title property (the Writer
// creates rows through it), and a title is either empty or not — an exhaustive pair, which is how a
// "match everything" filter is expressed here (Notion's query wants a filter; the store's own
// `list("all")` uses the same idiom).
const ANY = {
	or: [
		{ property: "Name", title: { is_empty: true } },
		{ property: "Name", title: { is_not_empty: true } }
	]
};

// list() — every doc, flattened to its writable properties plus id + url. The WHOLE set (queryAll
// walks the cursor): an archive that silently capped at one page would read as complete.
// Store order, deliberately unsorted: the app sorts newest-edit-first on `last_edited_time`, which
// is page metadata a flat Row drops — claiming that order here without it would be a lie. Bodies
// are `show`'s job; a list of 50 docs must not fetch 50 whole documents.
export const list = async (): Promise<Record<string, unknown>[]> =>
	(await queryAll(store, ds(), ANY)).map(({ id, fields }) => ({ id, url: pageUrl(id), ...fields }));

// show(handle) — one doc by id, Notion URL or app URL: its properties and its body as markdown,
// the document itself. The two reads are independent, so they go in one flight.
export const show = async (handle: string): Promise<Record<string, unknown>> => {
	const id = idOf(handle);
	const [row, markdown] = await Promise.all([store.get(id), store.body(id)]);
	return { id: row.id, url: pageUrl(row.id), ...row.fields, markdown };
};

// The app the push goes through. Locally that is `./op-dev.sh`'s dev server; SALESFLOCK_APP_URL
// overrides (the same var an `open` link is built from). The bare 32-hex id is what the app keys its
// live channel on, so it must match the form the editor uses.
const appBase = (): string => (process.env.SALESFLOCK_APP_URL ?? "http://localhost:5173").replace(/\/+$/, "");

// push(handle, {markdown, title?}) — hand the app a new version of a document: it saves it to Notion
// and hands it to the editor that has it open, live. An omitted `title` leaves the page's Name alone
// (the sink's contract), so a body-only push can't rename a draft.
//
// The dev-only knob: `x-writer-push: local` is what makes the intent explicit, and the app accepts it
// only when it runs in dev — there is no key, and nothing to reach on the deployed app.
export const push = async (
	handle: string,
	{ markdown, title }: { markdown: string; title?: string }
): Promise<Record<string, unknown>> => {
	const base = appBase();
	const id = idOf(handle).replace(/-/g, "");
	const url = `${base}/api/doc/${id}`;
	const res = await fetch(url, {
		method: "PUT",
		headers: { "content-type": "application/json", "x-writer-push": "local" },
		body: JSON.stringify({ markdown, ...(title === undefined ? {} : { title }) })
	}).catch((e: unknown) => {
		// A refused connection is the ONE failure worth translating: the fix is a command, so name it.
		throw new Error(
			`push: no app at ${base} — start it (bash salesflock/app/op-dev.sh), or set SALESFLOCK_APP_URL. ${(e as Error).message}`
		);
	});
	if (!res.ok) throw new Error(`push: ${base} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
	return { id, pushed: url, ...((await res.json()) as object) };
};
