import { redirect } from "@sveltejs/kit";
import { actions as auth, mode } from "$lib/server/auth";
import { decision, decisions } from "$lib/server/notion";
import { decisionToJudgment } from "$lib/cards/decision";
import type { Actions, PageServerLoad } from "./$types";

export const actions: Actions = { signin: auth.signin, signout: auth.signout };

// the shared handle is the Notion page id without dashes — what the URL carries and the card
// exposes; normalize both sides before matching so a dashed id resolves the same card.
const norm = (id: string) => id.replace(/-/g, "");

// The deck, addressed by id in the URL. `/` (no id) redirects to the first pending decision so
// the address bar always names the on-screen one. `/<id>` opens the deck at that decision —
// pulling it in directly when it's outside the gated queue (decided or blocked), so any link
// resolves. `currentId` tells the deck where to start.
export const load: PageServerLoad = async ({ locals, params }) => {
	const user = locals.user;
	if (!user) return { user, mode, judgments: [], currentId: null };

	const queue = await decisions();
	if (!params.id) {
		if (queue.length) redirect(302, `/${norm(queue[0].id)}`);
		return { user, mode, judgments: [], currentId: null };
	}

	const wanted = norm(params.id);
	const rows = queue.some((d) => norm(d.id) === wanted) ? queue : [await decision(wanted), ...queue];
	return { user, mode, judgments: rows.map(decisionToJudgment), currentId: wanted };
};
