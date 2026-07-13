import { signIn, signOut } from "$lib/server/auth";
import { decisions } from "$lib/server/notion";
import type { Actions, PageServerLoad } from "./$types";

export const actions: Actions = { signin: signIn, signout: signOut };

export const load: PageServerLoad = async (event) => {
	const session = await event.locals.auth();
	if (!session?.user) return { user: null, decisions: [] };
	return { user: session.user, decisions: await decisions() };
};
