// The Google authenticator: OAuth via Auth.js (it owns PKCE, token exchange, the
// session cookie — we don't reimplement that). Our two contributions are the policy
// check in the signIn callback (reject before a session is ever minted) and a handle
// that maps Auth.js's session onto the app's uniform event.locals.user. Pair it with
// an allowlist policy (personal Google) or a domain policy (Workspace) — google.ts
// doesn't care which.

import { SvelteKitAuth } from "@auth/sveltekit";
import Google from "@auth/sveltekit/providers/google";
import { sequence } from "@sveltejs/kit/hooks";
import type { Handle } from "@sveltejs/kit";
import type { Auth, Policy } from "./types";

export const google = (env: Record<string, string | undefined>, policy: Policy): Auth => {
	const {
		handle: authjs,
		signIn,
		signOut
	} = SvelteKitAuth({
		providers: [Google],
		trustHost: true,
		// AUTH_SECRET / AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET are read by Auth.js itself.
		callbacks: { signIn: ({ profile }) => policy(profile?.email ?? "") }
	});

	// After Auth.js resolves the session, project it onto the app's uniform User.
	const project: Handle = async ({ event, resolve }) => {
		const session = await event.locals.auth();
		const email = session?.user?.email ?? null;
		event.locals.user = email ? { email, name: email } : null;
		return resolve(event);
	};

	return {
		handle: sequence(authjs, project),
		actions: { signin: signIn, signout: signOut },
		mode: "oauth"
	};
};
