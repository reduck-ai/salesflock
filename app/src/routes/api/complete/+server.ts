// The autocomplete sink: the editor POSTs the caret context here and gets back an inline
// continuation. Gated like /api/decide — only a signed-in visitor may spend a model call. The
// suggestion is grounded in exactly what the drafter saw: the Prompt's System + Instruction and
// the card's rendered Evidence (from the frozen Input) — reused, not rebuilt. Agent-agnostic: the
// evidence renderer is the $agent seam, so this serves whichever agent the app is bound to.

import { error, json } from "@sveltejs/kit";
import { decision } from "$lib/server/notion";
import { complete } from "$lib/server/complete";
import { renderEvidence } from "$agent/evidence";
import type { RequestHandler } from "./$types";

const CURSOR = "⟨CURSOR⟩";

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, "not signed in");
	const { id, field, prefix, suffix } = (await request.json()) as {
		id: string;
		field?: string; // the Output field being edited — only used to frame the prompt
		prefix?: string; // draft text before the caret
		suffix?: string; // draft text after the caret
	};
	if (!id) throw error(400, "missing decision id");

	const d = await decision(id);
	const evidence = renderEvidence(JSON.parse(d.fields.Input) as Record<string, string>);

	const prompt = [
		d.system,
		d.instruction,
		`## Evidence\n\n${evidence}`,
		`## Task\n\nYou are an inline autocomplete for a human editing the ${
			field ? `"${field}" field of the ` : ""
		}response. Continue the draft at ${CURSOR}. Return ONLY the text to insert at the cursor — ` +
			`no quotes, no preamble, and do not repeat text that is already there. Keep it short (a few words to one sentence), matching the surrounding voice.`,
		`## Draft\n\n${prefix ?? ""}${CURSOR}${suffix ?? ""}`
	]
		.filter(Boolean)
		.join("\n\n");

	return json({ completion: await complete(prompt) });
};
