// The reduck scripts this client composes. `sflock bind --client x` reads this to
// generate schema.ts; index.ts imports it for typed calls. Addresses live ONLY here —
// the keys name the generated types and the runtime handles. Only the verified-working
// scripts are wired. get_tweet (the evidence primitive, merged from get_replies) returns the
// focal post + its replies; get_user_feed carries the pinned-head / self-thread fix.

export const scripts = {
	search: "reduck/x.com/search_tweets",
	feed: "reduck/x.com/get_personal_feed",
	tweet: "reduck/x.com/get_tweet",
	userInfo: "reduck/x.com/get_user_info",
	userFeed: "reduck/x.com/get_user_feed",
	reply: "reduck/x.com/reply_to_tweet"
} as const;
