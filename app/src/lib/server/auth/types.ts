// The auth seam. Everything the app needs from "who is this visitor, and may they
// enter" reduces to this: a `handle` that populates event.locals.user, two form
// actions to start/end a session, and one `mode` bit telling the login view which
// control to render. Each authenticator (google, secret-link, …) is a module that
// satisfies `Auth`; the policy — who is allowed, given an email — is orthogonal.

import type { Action, Handle } from "@sveltejs/kit";

// What the app knows about a signed-in visitor. `email` is null when the
// authenticator carries no identity (secret-link); `name` is always the display label.
export interface User {
	email: string | null;
	name: string;
}

// Who is allowed, given a verified email. A pure function — the same email always
// decides the same way. Authenticators that carry no identity don't use one.
export type Policy = (email: string) => boolean;

export interface Auth {
	handle: Handle; // populates event.locals.user on every request
	actions: { signin: Action; signout: Action };
	mode: "oauth" | "key"; // the one bit the login view needs
}
