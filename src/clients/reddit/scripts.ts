// The reduck scripts on Reddit's surface. `sflock bind --client reddit` generates
// schema.ts; the client (index.ts) imports both. Addresses live ONLY here.

export const scripts = {
	threads: "reduck/reddit.com/get_subreddit_threads",
	// Not called by the funnel: a community's rules are fetched BY HAND (`reduck run`) and written into
	// the agent's config, so nothing at runtime re-reads them. Listed here because this is where
	// addresses live, and `bind` compiles its output type — what that manual run returns.
	info: "reduck/reddit.com/get_subreddit_info"
} as const;
