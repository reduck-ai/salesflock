// The autocomplete sink, shared by every writing surface: the editor POSTs the caret context here
// and gets back an inline continuation. Gated like /api/decide — only a signed-in visitor may spend a
// model call. The caret framing (⟨CURSOR⟩ + the Task/Draft blocks) is ONE construction; what varies
// is only the GROUNDING prepended to it, and that is what `id` discriminates:
//   id present  → a Decision card: the drafter's own context, reused not rebuilt — the Prompt's
//                 instructions (its page body) and the card's rendered Evidence (from the frozen
//                 Input, through the renderer of the agent that judged it, $agents/index).
//   id absent   → the standalone Writer: the document IS the draft, so there is nothing to fetch —
//                 the title is the whole grounding, and a longer budget suits prose.

import { error, json } from "@sveltejs/kit";
import { decision } from "$lib/server/notion";
import { complete } from "$lib/server/complete";
import { agentFor } from "$agents/index";
import { renderEvidence as genericEvidence } from "$core/linkedin/evidence";
import type { RequestHandler } from "./$types";

const CURSOR = "⟨CURSOR⟩";

// The grounded Decision context: the instructions the judge read, plus the evidence it read them
// against. Its own function so the writer path costs no Notion round-trip at all.
//
// Memoized per decision id, because this grounding is FROZEN: `Input` is a snapshot taken when the
// judgment was made, and the Prompt's body is immutable by id (server/notion memoizes it for the same
// reason). Only the caret moves between requests. Without this every keystroke paid a fresh Notion
// page fetch — measured at 250–430ms of an ~850ms round trip, while the same measurement put the
// model itself at ~540ms and the writer path, which fetches nothing, at 8ms of our own overhead.
const grounds = new Map<string, { system: string; evidence: string }>();
const decisionGround = async (id: string, field?: string): Promise<string[]> => {
	let g = grounds.get(id);
	if (!g) {
		const d = await decision(id);
		const renderEvidence = agentFor(d.promptName)?.renderEvidence ?? genericEvidence;
		g = {
			system: d.system ?? "",
			evidence: renderEvidence(JSON.parse(d.fields.Input) as Record<string, string>)
		};
		grounds.set(id, g);
	}
	return [
		g.system,
		`## Evidence\n\n${g.evidence}`,
		`You are an inline autocomplete for a human editing the ${
			field ? `"${field}" field of the ` : ""
		}response.`
	];
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, "not signed in");
	const { id, title, field, prefix, suffix } = (await request.json()) as {
		id?: string; // a Decision id ⇒ grounded in that card; absent ⇒ the Writer
		title?: string; // the Writer's document title — its whole grounding
		field?: string; // the Output field being edited — only used to frame the prompt
		prefix?: string; // draft text before the caret
		suffix?: string; // draft text after the caret
	};

	// A phrase completes a form field; prose wants a sentence. The one knob that differs.
	const max = id ? 16 : 64;
	const ground = id
		? await decisionGround(id, field)
		: [
				`You are an inline autocomplete for a writer drafting long-form content${
					title ? ` titled "${title}"` : ""
				}.`
			];

	const prompt = [
		...ground,
		`## Task\n\nContinue the draft at ${CURSOR}. Return ONLY the text to insert at the cursor — ` +
			`no quotes, no preamble, and do not repeat text that is already there. ` +
			(id
				? `Keep it short (a few words to one sentence), matching the surrounding voice.`
				: `Continue in the author's own voice and register — at most one or two sentences, ` +
					`picking up mid-sentence if the cursor sits mid-sentence.`),
		`## Draft\n\n${prefix ?? ""}${CURSOR}${suffix ?? ""}`
	].filter(Boolean);

	return json({ completion: await complete(prompt.join("\n\n"), max) });
};
