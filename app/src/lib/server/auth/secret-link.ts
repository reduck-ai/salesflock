// The secret-link authenticator: no identity, no OAuth, no policy — knowing the
// server-only ACCESS_KEY *is* the authorization. The shareable link is /?key=<ACCESS_KEY>.
// On a matching key we mint a session cookie (an HMAC token signed with the existing
// AUTH_SECRET, so it's unforgeable and self-expiring) and strip the key from the URL.
// Stateless by construction: no database, no new dependency. Reuses AUTH_SECRET.

import { redirect, type Action, type Handle } from "@sveltejs/kit";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Auth } from "./types";

const NAME = "session";
const TTL = 60 * 60 * 24 * 30; // 30 days

const safeEq = (a: string, b: string): boolean => {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
};

// token = "<exp>.<hmac(exp)>": unforgeable (needs AUTH_SECRET) and self-expiring.
const sign = (secret: string, exp: number) =>
	createHmac("sha256", secret).update(String(exp)).digest("base64url");
const mint = (secret: string) => {
	const exp = Math.floor(Date.now() / 1000) + TTL;
	return `${exp}.${sign(secret, exp)}`;
};
const valid = (secret: string, token: string | undefined): boolean => {
	const [exp, sig] = (token ?? "").split(".");
	const n = Number(exp);
	return !!sig && n > Date.now() / 1000 && safeEq(sig, sign(secret, n));
};

const req = (env: Record<string, string | undefined>, k: string): string => {
	const v = env[k];
	if (!v) throw new Error(`set ${k} — secret-link auth needs it`);
	return v;
};

export const secretLink = (env: Record<string, string | undefined>): Auth => {
	const key = req(env, "ACCESS_KEY");
	const secret = req(env, "AUTH_SECRET");
	const cookie = {
		path: "/",
		httpOnly: true,
		secure: true,
		sameSite: "lax",
		maxAge: TTL
	} as const;

	const handle: Handle = async ({ event, resolve }) => {
		// A key in the URL: mint the cookie iff it matches, then redirect to the bare
		// path so the secret never lingers in history or the address bar.
		if (event.url.searchParams.has("key")) {
			if (safeEq(event.url.searchParams.get("key") ?? "", key))
				event.cookies.set(NAME, mint(secret), cookie);
			throw redirect(303, event.url.pathname);
		}
		event.locals.user = valid(secret, event.cookies.get(NAME))
			? { email: null, name: "Team" }
			: null;
		return resolve(event);
	};

	// The paste-a-key path: same validation as the link.
	const signin: Action = async ({ request, cookies }) => {
		const given = String((await request.formData()).get("key") ?? "");
		if (safeEq(given, key)) cookies.set(NAME, mint(secret), cookie);
		throw redirect(303, "/");
	};
	const signout: Action = async ({ cookies }) => {
		cookies.delete(NAME, { path: "/" });
		throw redirect(303, "/");
	};

	return { handle, actions: { signin, signout }, mode: "key" };
};
