// The judgment sink: the card stack POSTs its WORKING COPY here and it lands on the Notion page.
// Gated — only a signed-in visitor may write. The output is kept opaque here (its schema is the
// Prompt's), so this endpoint stays card-type-agnostic. `commit` is the whole difference: false is
// a Save (the working copy is kept, the decision withheld), true is the decision.
//
// A commit can now DO something as well as record something (an agent's `act` — post the reply),
// which is a browser run behind this request, so it is measured in tens of seconds rather than the
// hundreds of milliseconds a Notion write takes. Hence maxDuration: the default cut the request off
// mid-run, which is the one failure worth engineering against here — the deed done, the record lost.

import { error, json } from "@sveltejs/kit";
import { record } from "$lib/server/notion";
import type { RequestHandler } from "./$types";

export const config = { maxDuration: 300 };

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, "not signed in");
	const { id, output, feedback, finalReasoning, commit } = (await request.json()) as {
		id: string;
		output: unknown; // the output as the human has it — committed when `commit`, else kept as a draft
		feedback?: string;
		finalReasoning?: string; // the statements as the human left them — opaque, card-type-agnostic
		commit?: boolean;
	};
	if (!id) throw error(400, "bad judgment");
	// Nothing rides back beyond ok: the rail's chain-keyed order already encodes what the deck opens
	// next (a refresh after the commit lands on it), and pipeline semantics stay server-side.
	await record(id, { output, feedback: feedback ?? "", finalReasoning, commit: !!commit });
	return json({ ok: true });
};
