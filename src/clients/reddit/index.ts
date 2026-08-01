// Reddit client — one thin typed wrapper over the one base script the funnel calls (no
// composition: it's one `reduck run`; persistence lives in the agent's tools, per README #3).
// Owns the one identity primitive: the canonical thread URL every store row and Decision keys on.

import { run } from "../reduck.js";
import { scripts } from "./scripts.js";
import type { Comment, Reply, Thread, Threads } from "./schema.js";

// The canonical thread URL — the ONE identity key (the `profileUrl` twin). Reddit renders the same
// thread under many shapes (with/without the title slug, trailing slash, query params, mixed-case
// subreddit); all collapse to https://www.reddit.com/r/<sub>/comments/<id>/ so no variant can fork
// a row. Loud on a non-thread string — a bad key would fork silently forever.
export const threadUrl = (url: string): string => {
	const m = url.match(/\/r\/([^/]+)\/comments\/([a-z0-9]+)/i);
	if (!m) throw new Error(`not a Reddit thread URL: ${url}`);
	return `https://www.reddit.com/r/${m[1].toLowerCase()}/comments/${m[2].toLowerCase()}/`;
};

// The community a thread belongs to, read off its canonical URL — threadUrl's twin, and the only
// honest source for it. The stored Subreddit column keeps whatever casing the scan was handed
// ("AI_Agents", "ai_agents"), so grouping on it forks one community into two; the URL is the
// identity key and was already lowercased, so it cannot. Loud on a non-thread string, via threadUrl.
export const subOf = (url: string): string => threadUrl(url).split("/")[4];

// The window grammar `get_subreddit_threads` speaks ("48h", "7d", or a plain ISO date) → the ISO
// instant it means. It lives here, beside the identity primitives, because that grammar is the
// SCRIPT's contract — and this is what makes `rdt scan --since 7d` and `rdt threads get --since 7d`
// mean the same seven days, though only one of them is talking to the script that defines it.
// Loud on anything else: a window silently read as "the epoch" would quietly select everything.
export const sinceIso = (window: string): string => {
	const m = window.match(/^(\d+)\s*([hd])$/i);
	if (m) return new Date(Date.now() - Number(m[1]) * (m[2].toLowerCase() === "h" ? 3_600_000 : 86_400_000)).toISOString();
	const t = Date.parse(window);
	if (Number.isNaN(t)) throw new Error(`not a window: "${window}" — use "48h", "7d", or an ISO date`);
	return new Date(t).toISOString();
};

// A subreddit's newest threads within a window — the funnel's ONE fetch: each thread carries its
// `body`, the post's FULL text (the script's contract), so discovery already yields the judged
// evidence. sort:"new" is chronological and the script's own `since` accepts shorthand ("48h", "7d").
export type { Thread, Threads };
export const getSubredditThreads = (subreddit: string, since = "48h"): Promise<Threads> =>
	run<Threads>(scripts.threads, { subreddit, sort: "new", since });

// One thread WITH its comment tree — the funnel's second read, for a post that survived the
// pre-screen. `all_comments` expands every "more replies" loader: the deciding line is often a
// reply the OP left several levels down (measured at depth 3), and a tree cut off at what Reddit
// happens to render on load would silently drop it — an absence indistinguishable from "nothing to
// find", which is the one thing a gate must never confuse.
export const getThread = (url: string): Promise<Thread> =>
	run<Thread>(scripts.thread, { url: threadUrl(url), all_comments: true });

// The two writes — the only calls in this file that change anything on Reddit, and the reason the
// agent stopped being read-only. `say(url, text)` opens a conversation under a post; `answer(
// permalink, text)` continues one. Both hand back the created comment's permalink: the identity the
// outreach is keyed on afterwards, and the anchor the next answer hangs off. Deliberately two
// functions rather than one with a mode flag — they take different addresses (a post, a comment)
// and a caller that has to pick between them cannot silently post a follow-up as a fresh comment.
export type { Comment, Reply };
export const say = (url: string, text: string): Promise<Comment> =>
	run<Comment>(scripts.comment, { url: threadUrl(url), text });
export const answer = (permalink: string, text: string): Promise<Reply> =>
	run<Reply>(scripts.reply, { permalink, text });
