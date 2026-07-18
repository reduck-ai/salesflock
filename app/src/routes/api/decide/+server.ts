// The judgment sink: the card stack POSTs one Judgment here and it lands on the
// Notion page. Gated — only a signed-in visitor may write. The verdict shape is the
// card seam's Verdict, so this endpoint is card-type-agnostic like everything else.

import { error, json } from "@sveltejs/kit";
import { record } from "$lib/server/notion";
import type { Verdict } from "$lib/cards/types";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, "not signed in");
	const { id, verdict, feedback, finalOutput, finalReasoning } = (await request.json()) as {
		id: string;
		verdict: Verdict;
		feedback?: string;
		finalOutput?: string; // the output as the human accepted it — opaque here, card-type-agnostic
		finalReasoning?: string; // the statements as the human accepted them — opaque, likewise
	};
	if (!id || (verdict !== "accepted" && verdict !== "rejected")) throw error(400, "bad judgment");
	await record(id, verdict, feedback ?? "", finalOutput, finalReasoning);
	return json({ ok: true });
};
