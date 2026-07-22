// One card's full judgment by id — the client-cached fetch behind the deck. The universal load
// (`[[id]]/+page.ts`) hits this only on a cache miss, so a re-viewed card costs nothing. Gated:
// only a signed-in visitor may read. Reuses the same primitives the SSR path used (decision +
// decisionToJudgment); no gate on the lookup, so any linked card resolves.

import { error, json } from "@sveltejs/kit";
import { decision } from "$lib/server/notion";
import { decisionToJudgment } from "$lib/cards/decision";
import type { RequestHandler } from "./$types";

const norm = (id: string) => id.replace(/-/g, "");

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, "not signed in");
	return json(decisionToJudgment(await decision(norm(params.id))));
};
