// The reduck scripts on Reddit's surface. `sflock bind --client reddit` generates
// schema.ts; the client (index.ts) imports both. Addresses live ONLY here.

export const scripts = {
	threads: "reduck/reddit.com/get_subreddit_threads",
	info: "reduck/reddit.com/get_subreddit_info"
} as const;
