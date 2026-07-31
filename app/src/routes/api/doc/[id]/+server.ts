// The save sink: the editor PUTs the whole document (title + body markdown) and it lands on the
// Notion page. Gated like /api/decide and /api/complete — only a signed-in visitor may write. The
// whole document, never a patch: the editor is the authority on its own text, so a save is a
// statement of what the document IS (server/writer.ts → wipe + append).

import { error, json } from "@sveltejs/kit";
import { save } from "$lib/server/writer";
import type { RequestHandler } from "./$types";

export const PUT: RequestHandler = async ({ request, params, locals }) => {
	if (!locals.user) throw error(401, "not signed in");
	const { title, markdown } = (await request.json()) as { title?: string; markdown?: string };
	await save(params.id, { title: title ?? "", markdown: markdown ?? "" });
	return json({ ok: true, saved: new Date().toISOString() });
};
