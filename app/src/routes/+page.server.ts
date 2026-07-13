import { actions as auth, mode } from "$lib/server/auth";
import { decisions } from "$lib/server/notion";
import { decisionToCard } from "$lib/cards/decision";
import type { Actions, PageServerLoad } from "./$types";

export const actions: Actions = { signin: auth.signin, signout: auth.signout };

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user;
	const cards = user ? (await decisions()).map(decisionToCard) : [];
	return { user, mode, cards };
};
