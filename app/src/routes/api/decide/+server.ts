// The judgment sink: the card stack POSTs one Judgment here and it lands on the Notion page.
// Gated — only a signed-in visitor may write. The committed output IS the decision, kept opaque
// here (its schema is the Prompt's), so this endpoint stays card-type-agnostic. A judgment with
// no `committedOutput` is a Save — the human's edits persist, the decision is withheld.

import { error, json } from "@sveltejs/kit";
import { record } from "$lib/server/notion";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, "not signed in");
	const { id, committedOutput, feedback, finalReasoning } = (await request.json()) as {
		id: string;
		committedOutput?: unknown; // the schema-valid output the human commits — absent for a Save
		feedback?: string;
		finalReasoning?: string; // the statements as the human left them — opaque, card-type-agnostic
	};
	if (!id) throw error(400, "bad judgment");
	await record(id, { committedOutput, feedback: feedback ?? "", finalReasoning });
	return json({ ok: true });
};
