// X (Twitter) client — packages the working x.com base scripts behind typed calls, and
// normalizes the two identity keys in one place. Each call is a single `reduck run` (the
// client exists so the agent speaks one seam, mirroring the Lk client). No persistence —
// the agent's tools write to the CRM. Every run fails loud: a scrape failure throws; a
// genuinely empty result (no tweets/replies) returns [] / count 0 on its own.

import { run } from "../reduck.js";
import { scripts } from "./scripts.js";
import type { Search, Feed, Tweet, UserInfo, UserPosts, UserReplies, Reply } from "./schema.js";

// A bare handle from an @handle, a profile URL, or a status URL — X handles are ≤15 chars of
// [A-Za-z0-9_]. This is the person's identity; every author row keys on the profile URL below.
export const handleOf = (x: string): string =>
	x.match(/(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})/i)?.[1] ?? x.replace(/^@/, "");

// The canonical profile URL — the ONE identity key every author row upserts on. Accepts an
// @handle, a bare handle, or any profile/status URL; always normalizes to x.com/<handle>.
export const profileUrl = (handle: string): string => `https://x.com/${handleOf(handle)}`;

// A post's numeric id from a status URL (a bare id passes through) — the stable join key a Post
// row keys on. The display URL X returns (handle/status/id) is what search/replies/reply address,
// so it is carried verbatim rather than reconstructed; this is only for the identity scalar.
export const tweetIdOf = (url: string): string => url.match(/status\/(\d+)/)?.[1] ?? url;

// search_tweets — discover posts by query. Full text + author + follower reach + url.
export const searchTweets = (
	query: string,
	opts: { tab?: "top" | "latest"; count?: number } = {}
): Promise<Search> =>
	run<Search>(scripts.search, {
		query,
		...(opts.tab ? { tab: opts.tab } : {}),
		...(opts.count ? { count: opts.count } : {})
	});

// get_personal_feed — your For You home feed: the MVP's discovery surface. Per post: author,
// full text, reply_count (the gate for the signal), and nested quoted/retweeted refs.
export const getPersonalFeed = (count?: number): Promise<Feed> =>
	run<Feed>(scripts.feed, { ...(count ? { count } : {}) });

// get_tweet — the focal post plus its replies (a ranked sample), each reply carrying author +
// in_reply_to. The evidence primitive: `replies[]` feeds the engagement signal (an OP reply whose
// in_reply_to is another replier's id), and `tweet` is the post itself (null if deleted).
export const getTweet = (tweetUrl: string, count?: number): Promise<Tweet> =>
	run<Tweet>(scripts.tweet, { tweet_url: tweetUrl, ...(count ? { count } : {}) });

// get_user_info — the author's profile (identity + reach), keyed by handle.
export const getUserInfo = (handle: string): Promise<UserInfo> =>
	run<UserInfo>(scripts.userInfo, { handle: handleOf(handle) });

// get_user_posts — a person's own Posts tab (self-threads + reposts, newest first; excludes replies
// to others). The owner-voice corpus: how they write their own posts.
export const getUserPosts = (handle: string, count?: number): Promise<UserPosts> =>
	run<UserPosts>(scripts.userPosts, { handle: handleOf(handle), ...(count ? { count } : {}) });

// get_user_replies — a person's own Replies tab (/<handle>/with_replies): their replies to others,
// each carrying in_reply_to {id, author_handle} (null on a plain post). The owner's real reply
// voice — the calibration corpus `hydrate` scrapes.
export const getUserReplies = (handle: string, count?: number): Promise<UserReplies> =>
	run<UserReplies>(scripts.userReplies, { handle: handleOf(handle), ...(count ? { count } : {}) });

// reply_to_tweet — the one engagement action: reply under a post to borrow its reach.
export const reply = (tweetUrl: string, text: string): Promise<Reply> =>
	run<Reply>(scripts.reply, { tweet_url: tweetUrl, text });

export type { Search, Feed, Tweet, UserInfo, UserPosts, UserReplies, Reply };
