// The Writer's list screen: every doc, and the one action that makes a new one. The status FILTER is
// the page's own (over rows already fetched) — no reload, no server round-trip per tab, the same
// reasoning `decisions()` applies to its in-code filters.

import { error, redirect } from "@sveltejs/kit";
import { docs, create } from "$lib/server/writer";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) return { user: null, rows: [] };
	return { user: locals.user, rows: await docs() };
};

export const actions: Actions = {
	// New — create then GO there. A doc you cannot see is not created as far as the writer is
	// concerned, so the redirect is part of the action, not a follow-up click.
	new: async ({ locals }) => {
		if (!locals.user) throw error(401, "not signed in");
		const id = await create();
		throw redirect(303, `/write/${id.replace(/-/g, "")}`);
	}
};
