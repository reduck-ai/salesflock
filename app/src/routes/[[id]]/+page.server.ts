import { actions as auth } from "$lib/server/auth";
import type { Actions } from "./$types";

// The card fetch lives in the universal +page.ts (so it can hit the client cache); the rail + user
// live in +layout.server.ts. This file is left with only the form actions — sign in / out.
export const actions: Actions = { signin: auth.signin, signout: auth.signout };
