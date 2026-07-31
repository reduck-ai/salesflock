// The watched communities' own rules — what each subreddit allows a commenter to do (links,
// self-promotion, disclosure), which is what a drafted reply must obey. Rules belong to the
// COMMUNITY, not to a thread, so they are held once per subreddit here rather than copied onto every
// thread row, and joined into the evidence at judgment time (tools.ts `resolveSubject`).
//
// The store is a file beside the agent, not a CRM table: four rows of prose that a scrape can
// regenerate need no data source, and a file works with no network — a draft can be judged offline.
// `scan` already visits each subreddit once, so it refreshes this in the same step (one extra reduck
// run per subreddit, never per thread) and nothing else has to be maintained by hand.
//
// Only what a reply must read is persisted — name, visibility, rules. Member counts and the
// moderator list are dropped on purpose: they change every scan, so keeping them would make every
// scan dirty the file, and a diff here is meant to say ONE thing — this community changed its rules.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import type { Info } from "../../src/clients/reddit/index.js";

// Beside the SOURCE file, not the build output: `dist/` mirrors the tree, so the same relative walk
// resolves from either, and it is independent of the cwd `rdt` was launched from.
const FILE = fileURLToPath(new URL("../../../agents/reddit-engage/subreddits.yaml", import.meta.url));

// What we keep of a subreddit: its canonical name, what the page says about visibility, and the
// rules verbatim. Verbatim matters twice — a rule's exact wording decides behavior ("put your links
// in the comments, not the posts" permits in a comment exactly what it forbids in a post), and the
// drafter cites it through `search_quotes` like any other evidence.
export interface Subreddit {
	subreddit: string;
	status: string;
	rules: { title: string; body: string }[];
}

const key = (subreddit: string): string => subreddit.replace(/^r\//i, "").toLowerCase();

const text = (): string => {
	try {
		return readFileSync(FILE, "utf8");
	} catch {
		return ""; // no file yet — the first scan writes it
	}
};
const load = (): Subreddit[] => (parse(text()) as Subreddit[] | null) ?? [];

// The scrape → what we keep, name-keyed and rule-ordered as the page listed them.
const trim = (info: Info): Subreddit => ({
	subreddit: key(info.subreddit),
	status: info.status,
	rules: (info.rules ?? []).map((r) => ({ title: r.title ?? "", body: r.body ?? "" }))
});

// remember(info) — fold one freshly scraped subreddit into the file, sorted by name. Writes ONLY on
// a real change, so an unchanged scan leaves the working tree clean and a commit here always means
// a community moved its goalposts.
export const remember = (info: Info): void => {
	const next = [...load().filter((s) => s.subreddit !== key(info.subreddit)), trim(info)].sort((a, b) =>
		a.subreddit.localeCompare(b.subreddit)
	);
	const yaml = stringify(next, { lineWidth: 0 });
	if (yaml !== text()) writeFileSync(FILE, yaml);
};

// rulesOf(subreddit) — the community's rules as the markdown a judge reads, or undefined when this
// subreddit has never been scanned. The three cases stay distinct on purpose (never fuse "no data"
// with "nothing to obey"): rules → the list; scanned with none published → said so in words;
// unknown → undefined, so the field is simply absent from the evidence and the prompt's own
// conservative default applies.
export const rulesOf = (subreddit: string): string | undefined => {
	const found = load().find((s) => s.subreddit === key(subreddit));
	if (!found) return undefined;
	const status = found.status && found.status !== "public" ? ` (this community is ${found.status})` : "";
	return found.rules.length
		? `r/${found.subreddit}${status} publishes these rules:\n\n` +
				found.rules.map((r) => `- **${r.title}** — ${r.body.replace(/\s+/g, " ").trim()}`).join("\n")
		: `r/${found.subreddit}${status} publishes no rules.`;
};
