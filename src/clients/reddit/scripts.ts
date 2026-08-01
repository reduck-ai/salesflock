// The reduck scripts on Reddit's surface. `sflock bind --client reddit` generates
// schema.ts; the client (index.ts) imports both. Addresses live ONLY here.

export const scripts = {
	threads: "reduck/reddit.com/get_subreddit_threads",
	// The SECOND read of a thread, for one that survived the pre-screen: the same post plus its
	// comment tree. The listing already carries the full post text, so this buys exactly one thing —
	// what was said BELOW it, where an OP volunteers what the post never claims ("I'm a broke
	// student", "there's no audience for now"). Measured: that evidence sits at depth 3, behind a
	// "more replies" loader, which is why the funnel asks for the whole tree.
	thread: "reduck/reddit.com/get_thread",
	// Not called by the funnel: a community's rules are fetched BY HAND (`reduck run`) and written into
	// the agent's config, so nothing at runtime re-reads them. Listed here because this is where
	// addresses live, and `bind` compiles its output type — what that manual run returns.
	info: "reduck/reddit.com/get_subreddit_info"
} as const;
