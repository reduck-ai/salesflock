// The gate. Google sign-in via Auth.js; only addresses on ALLOWED_EMAILS
// (comma-separated) may enter — enforced server-side in the OAuth callback,
// so inviting a team member is adding their address to the env var.
// AUTH_SECRET / AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET are read by Auth.js itself.

import { SvelteKitAuth } from "@auth/sveltekit";
import Google from "@auth/sveltekit/providers/google";
import { env } from "$env/dynamic/private";

const allowed = new Set(
	(env.ALLOWED_EMAILS ?? "")
		.split(",")
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean)
);

export const { handle, signIn, signOut } = SvelteKitAuth({
	providers: [Google],
	trustHost: true,
	callbacks: {
		signIn: ({ profile }) => allowed.has((profile?.email ?? "").toLowerCase())
	}
});
