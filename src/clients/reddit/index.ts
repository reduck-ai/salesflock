// Reddit client — one thin typed wrapper over the one base script the funnel calls (no
// composition: it's one `reduck run`; persistence lives in the agent's tools, per README #3).
// Owns the one identity primitive: the canonical thread URL every store row and Decision keys on.

import { run } from "../reduck.js";
import { scripts } from "./scripts.js";
import type { Thread, Threads } from "./schema.js";

// The canonical thread URL — the ONE identity key (the `profileUrl` twin). Reddit renders the same
// thread under many shapes (with/without the title slug, trailing slash, query params, mixed-case
// subreddit); all collapse to https://www.reddit.com/r/<sub>/comments/<id>/ so no variant can fork
// a row. Loud on a non-thread string — a bad key would fork silently forever.
export const threadUrl = (url: string): string => {
	const m = url.match(/\/r\/([^/]+)\/comments\/([a-z0-9]+)/i);
	if (!m) throw new Error(`not a Reddit thread URL: ${url}`);
	return `https://www.reddit.com/r/${m[1].toLowerCase()}/comments/${m[2].toLowerCase()}/`;
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
