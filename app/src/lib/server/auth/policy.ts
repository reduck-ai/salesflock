// The "who is allowed" axis, built from env. Two shapes: an explicit email allowlist,
// or a domain allowlist (the Workspace case — anyone @your-company.com). ALLOWED_EMAILS
// wins when both are set. Neither set is a misconfiguration, not "allow everyone": we
// throw, so the gate fails closed rather than silently opening.

import type { Policy } from "./types";

const set = (v: string | undefined): Set<string> =>
	new Set(
		(v ?? "")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean)
	);

// The check is per-request (deciding an email), not per-import — so a build-time
// module import never trips the fail-closed throw.
export const policyFromEnv = (env: Record<string, string | undefined>): Policy => {
	const emails = set(env.ALLOWED_EMAILS);
	const domains = set(env.ALLOWED_DOMAINS);
	return (email) => {
		if (emails.size) return emails.has(email.toLowerCase());
		if (domains.size) return domains.has(email.split("@")[1]?.toLowerCase() ?? "");
		throw new Error(
			"set ALLOWED_EMAILS or ALLOWED_DOMAINS — the gate refuses to open to everyone"
		);
	};
};
