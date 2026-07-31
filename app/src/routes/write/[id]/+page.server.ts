// Screen two's data: one document, body included. No gate of its own — the app-wide auth handle
// establishes the visitor, and `locals.user` decides whether there is anything to load.

import { error } from "@sveltejs/kit";
import { doc } from "$lib/server/writer";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) throw error(401, "not signed in");
	return { doc: await doc(params.id) };
};
