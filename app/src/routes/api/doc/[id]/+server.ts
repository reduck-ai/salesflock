// One document's wire: the editor's save sink, its live channel, and the manual re-read — one route,
// because they are one document and one payload shape.
//
// PUT — the whole document (title + body markdown) lands on the Notion page. The whole document, never
// a patch: the editor is the authority on its own text, so a save is a statement of what the document
// IS (server/writer.ts → append then wipe). Then it PUBLISHES, which is what lets a save made
// elsewhere reach an open editor with no reload. `sflock docs push` is exactly this call — the agent
// writes through the same sink the editor does, so there is ONE write path and the live fan-out is
// free rather than a second mechanism.
//
// GET — the same URL twice over, discriminated by Accept (which EventSource sets for free): as JSON it
// is the manual Pull (the editor's "Sync ↓", also how a doc edited in Notion is re-read), and as
// text/event-stream it is the live subscription. Same loader (`doc`), same payload, so the editor has
// ONE apply path for both triggers.
//
// The gate: signed-in, as everywhere else — OR the local push knob, which exists only in dev (`dev`
// from $app/environment, so the bypass is not in the deployed build at all). That is the whole
// authorization story: no key to manage, and nothing to reach in production.

import { dev } from "$app/environment";
import { error, json } from "@sveltejs/kit";
import { doc, save } from "$lib/server/writer";
import { publish, subscribe } from "$lib/server/live";
import type { RequestHandler } from "./$types";

// The one authorization: a signed-in visitor, or a local push. `x-writer-push` is not a secret — it is
// what makes the intent explicit; `dev` is what makes it unreachable in production.
const allowed = (locals: App.Locals, request: Request): boolean =>
	!!locals.user || (dev && request.headers.get("x-writer-push") === "local");

const PING_MS = 25_000;

export const GET: RequestHandler = async ({ params, request, locals }) => {
	if (!allowed(locals, request)) throw error(401, "not signed in");
	if (!request.headers.get("accept")?.includes("text/event-stream")) return json(await doc(params.id));

	// The live subscription. Nothing is replayed on connect: an editor that just mounted already has
	// the document from its own loader, and one that reconnects can Pull.
	const encoder = new TextEncoder();
	let stop: (() => void) | undefined;
	let beat: ReturnType<typeof setInterval> | undefined;
	const stream = new ReadableStream({
		start(controller) {
			const send = (chunk: string) => {
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					// The client is gone (a closed tab, a navigation) — stop watching rather than throwing
					// into a writer's save. `cancel` may not have run yet, so tear down here too.
					stop?.();
					clearInterval(beat);
				}
			};
			stop = subscribe(params.id, (data) => send(`data: ${data}\n\n`));
			beat = setInterval(() => send(": ping\n\n"), PING_MS); // keeps proxies from closing an idle stream
		},
		cancel() {
			stop?.();
			clearInterval(beat);
		}
	});
	return new Response(stream, {
		headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" }
	});
};

export const PUT: RequestHandler = async ({ request, params, locals }) => {
	if (!allowed(locals, request)) throw error(401, "not signed in");
	const { title, markdown } = (await request.json()) as { title?: string; markdown?: string };
	await save(params.id, { title, markdown: markdown ?? "" });
	// `from` is the saver's own client token: an editor ignores the echo of its own save, so its caret
	// and undo history survive its autosave. A push sends no token, so every open editor applies it.
	publish(params.id, {
		title,
		markdown: markdown ?? "",
		from: request.headers.get("x-writer-client") ?? undefined
	});
	return json({ ok: true, saved: new Date().toISOString() });
};
