import { actions as auth, mode } from "$lib/server/auth";
import { decisions } from "$lib/server/notion";
import { decisionToJudgment } from "$lib/cards/decision";
import type { Actions, PageServerLoad } from "./$types";

export const actions: Actions = { signin: auth.signin, signout: auth.signout };

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user;
	const judgments = user ? (await decisions()).map(decisionToJudgment) : [];
	return { user, mode, judgments };
};
