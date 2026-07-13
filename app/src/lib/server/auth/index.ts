// Assembly: pick the authenticator by AUTH_PROVIDER (default "google", so the app
// runs gated out of the box), give the google one its policy, and re-export the seam.
// Switching gate is a one-line env change, never a code change — the app imports only
// { handle, actions, mode } and never learns which module answered.

import { env } from "$env/dynamic/private";
import { google } from "./google";
import { secretLink } from "./secret-link";
import { policyFromEnv } from "./policy";
import type { Auth } from "./types";

const auth: Auth =
	(env.AUTH_PROVIDER ?? "google") === "secret-link"
		? secretLink(env)
		: (env.AUTH_PROVIDER ?? "google") === "google"
			? google(env, policyFromEnv(env))
			: (() => {
					throw new Error(
						`unknown AUTH_PROVIDER "${env.AUTH_PROVIDER}" — one of: google, secret-link`
					);
				})();

export const { handle, actions, mode } = auth;
