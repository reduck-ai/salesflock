// The reduck scripts this client composes. `sflock bind --client x` reads this to
// generate schema.ts; index.ts imports it for typed calls. Addresses live ONLY here —
// the keys name the generated types and the runtime handles. Only the verified-working
// scripts are wired. get_tweet (the evidence primitive, merged from get_replies) returns the
// focal post + its replies; the owner's voice corpus splits into two honest scripts —
// get_user_posts (the Posts tab) and get_user_replies (the Replies tab, /with_replies).

export const scripts = {
	search: "reduck/x.com/search_tweets",
	feed: "reduck/x.com/get_personal_feed",
	tweet: "reduck/x.com/get_tweet",
	userInfo: "reduck/x.com/get_user_info",
	userPosts: "reduck/x.com/get_user_posts",
	userReplies: "reduck/x.com/get_user_replies",
	reply: "reduck/x.com/reply_to_tweet"
} as const;
