// Reddit client — one thin typed wrapper over the one base script the funnel calls (no
// composition: it's one `reduck run`; persistence lives in the agent's tools, per README #3).
// Owns the one identity primitive: the canonical thread URL every store row and Decision keys on.

import { run, runAll, type RunOpts } from "../reduck.js";
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

// The canonical URL of a Reddit ACCOUNT — threadUrl's twin, and the second identity key this
// source mints: the Reddit Backlog keys an outreach on the PERSON, because a human who posts
// twice is one human to talk to, not two. (Measured, the hard way: one author cross-posted the
// same question to two subreddits and we replied to both, eighteen minutes apart.)
//
// Same contract as threadUrl, for the same reason — Reddit renders a user under many shapes
// (u/Name, /user/Name, a bare handle, any casing) and a username is case-INSENSITIVE for lookup,
// so `SrvLdr` and `srvldr` are one account. All collapse to
// https://www.reddit.com/user/<lowercased>/ so no spelling can fork a row.
//
// Loud on anything that is not a username, and that is the load-bearing half: "[deleted]" is
// Reddit's word for an account that is gone, and keying an outreach on it would fuse every
// deleted author in the store into ONE person. Absence and "[deleted]" are the same fact here —
// there is nobody to talk to — so both throw rather than resolve to a shared bucket. (0 of the 53
// qualified threads lack an author, so this is a guard, not a funnel gate.)
export const userUrl = (author: string): string => {
	// ONE anchored match over the WHOLE string, never a chain of strips: the accepted shapes are
	// enumerated here, so anything else is rejected rather than mangled into something plausible.
	// (Both halves are load-bearing. Stripping prefixes left a pasted profile URL's trailing slash
	// on, so the first thing anyone pastes failed. Matching the last path segment instead accepted
	// a THREAD url — "…/comments/1veqz5n/" reads as the username "1veqz5n" — which would key an
	// outreach on a person who does not exist. Anchored, that cannot parse at all.)
	const name = author
		.trim()
		.replace(/[?#].*$/, "")
		.match(/^(?:(?:https?:\/\/)?(?:www\.)?reddit\.com)?\/?(?:u(?:ser)?\/)?([A-Za-z0-9_-]{3,20})\/?$/i)?.[1];
	if (!name) throw new Error(`not a Reddit username: ${JSON.stringify(author)}`);
	return `https://www.reddit.com/user/${name.toLowerCase()}/`;
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
// A time window is not this source's idea — it moved to src/time.ts the day a second agent needed
// one. Re-exported so a reader who expects it beside the other reddit helpers still finds it.
export { sinceIso } from "../../time.js";

// A subreddit's newest threads within a window — the funnel's ONE fetch: each thread carries its
// `body`, the post's FULL text (the script's contract), so discovery already yields the judged
// evidence. sort:"new" is chronological and the script's own `since` accepts shorthand ("48h", "7d").
//
// Every function here takes a trailing `opts` — WHERE the run executes, i.e. which browser and so
// which signed-in Reddit account the site sees doing this. The client cannot choose it: the reading
// account, the writing account and the cloud belong to whoever owns them, which is the agent
// (agents/reddit-engage/config.ts DEVICES), and core must not import an agent. What the client DOES
// own is the read/write line below, so the caller only has to know that much.
export type { Thread, Threads };
export const getSubredditThreads = (subreddit: string, since = "48h", opts?: RunOpts): Promise<Threads> =>
	run<Threads>(scripts.threads, { subreddit, sort: "new", since }, opts);

// Every watched subreddit's listing in ONE request — each on its own browser, one outcome per
// subreddit (a rejection never removes the others' threads). Discovery is the one stage that asks
// the same question of several communities at once, so it is the one that should ask once: a
// six-community scan is one request and one poll rather than six of each.
export const getSubredditThreadsAll = (
	subreddits: readonly string[],
	since = "48h",
	opts?: RunOpts
): Promise<PromiseSettledResult<Threads>[]> =>
	runAll<Threads>(
		subreddits.map((subreddit) => ({ addr: scripts.threads, args: { subreddit, sort: "new", since } })),
		opts
	);

// One thread WITH its comment tree — the funnel's second read, for a post that survived the
// pre-screen. `all_comments` expands every "more replies" loader: the deciding line is often a
// reply the OP left several levels down (measured at depth 3), and a tree cut off at what Reddit
// happens to render on load would silently drop it — an absence indistinguishable from "nothing to
// find", which is the one thing a gate must never confuse.
export const getThread = (url: string, opts?: RunOpts): Promise<Thread> =>
	run<Thread>(scripts.thread, { url: threadUrl(url), all_comments: true }, opts);

// The two writes — the only calls in this file that change anything on Reddit, and the reason the
// agent stopped being read-only. `say(url, text)` opens a conversation under a post; `answer(
// permalink, text)` continues one. Both hand back the created comment's permalink: the identity the
// outreach is keyed on afterwards, and the anchor the next answer hangs off. Deliberately two
// functions rather than one with a mode flag — they take different addresses (a post, a comment)
// and a caller that has to pick between them cannot silently post a follow-up as a fresh comment.
// They are also the two calls whose target decides WHOSE name is on the comment, which is why the
// read/write line and the account line are the same line: a scrape may be done by anyone — the
// cloud browser included — a reply may only be done by us, on the one paired browser signed in as us.
export type { Comment, Reply };
export const say = (url: string, text: string, opts?: RunOpts): Promise<Comment> =>
	run<Comment>(scripts.comment, { url: threadUrl(url), text }, opts);
export const answer = (permalink: string, text: string, opts?: RunOpts): Promise<Reply> =>
	run<Reply>(scripts.reply, { permalink, text }, opts);
