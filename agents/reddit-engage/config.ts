// reddit-engage — subreddit-driven Reddit engagement:
//   scan the watched subreddits' new threads → qualify (LLM, title + post; a judgment, NOT a
//   Decision — nobody reviews it, so its whole record is the thread's Tier and a comment on the
//   thread page) → reply draft (LLM) → [human gate, which POSTS].
//
// TWO tables, split by who writes them, because they change for unrelated reasons (README #4 —
// pipeline state is a join, not a column):
//   Reddit Threads   what Reddit says + what we concluded about the thread (Tier). Mutable only
//                    because we re-read Reddit. No funnel state at all.
//   Reddit Backlog   our outreach on one thread: its state, the comment we posted, when. One row
//                    per thread we chose to engage — a hundredth of the threads we have seen.
// Both keyed on the canonical Thread URL (the ONE identity, src/clients/reddit/index.ts), plus the
// two universal tables every agent shares (Decisions, Prompts). No People table: the thread IS the
// unit, its author a flat column. `sflock pull --agent reddit-engage` reads this to regenerate
// schema/*.ts; the runtime reads it to address each table.
//
// The agent is no longer read-only, and the one place it writes to Reddit is `reply.act` below —
// inside the human's Confirm, never in a background pass.

import type { AgentConfig } from "../../src/stores/index.js";
import { say, threadUrl } from "../../src/clients/reddit/index.js";

// The watchlist AND each community's own rules — ONE declaration: which subreddits `scan` watches,
// keyed by canonical name (lowercase, bare), each mapped to the rules a reply posted there must obey.
// Adding a subreddit is one decision, so it is one entry.
//
// The value is the evidence VERBATIM — the exact markdown the judge reads (joined in by tools.ts
// `resolveSubject`, frozen into the Decision's Input, rendered by the review app, and quotable through
// `search_quotes`). No shape, no renderer, no per-case branch: whatever is written here is what the
// drafter obeys, and the community's own wording is what decides behavior — "put your links in the
// comments, not the posts" permits in a comment exactly what it forbids in a post.
//
// Adding a subreddit, the whole process — fetch its rules, write the entry, commit:
//
//   reduck run --script reduck/reddit.com/get_subreddit_info subreddit=<name>
//
// By hand, once, because that is all it is: a community publishes its rules about as often as it
// renames itself. No tool wraps this (a wrapper adding neither composition nor persistence shouldn't
// exist), nothing refreshes it at runtime, and the id and its rules land in the same diff — so they
// cannot drift apart, and a diff here says one thing: this community changed what it allows.
//
// The two negatives stay distinct, and the DATA says which: a community that publishes no rules says
// so in words, while a subreddit absent from this map was never derived — so the evidence omits the
// field entirely and the prompt's strictest reading applies. Never fuse the two.
export const SUBREDDITS: Record<string, string> = {
	ai_agents: `- **Be respectful** — Treat others how you'd like to be treated
- **No spam** — Spammers will be permanently banned.
- **Put your links in the comments, not the posts** — This is mainly to prevent spam. If you have a blog post you want to link, link it in the comments. If you have a project you want to show off, link it in the weekly project display thread.
- **Limit self promotion** — Self promotion is fine, but if your posts are all self promotion (including promotion of your projects/products), you will be banned. A good ratio is one out of ten posts/comments.
- **No Low Effort Posts** — If your post provides no context, or it is simply meant to drive people off the site and somewhere else, it will be removed.`,

	automation: `- **Be nice to one another.** — Breach of our be nice rule. Please take a minute to read the reddiquette. https://www.reddithelp.com/hc/en-us/articles/205926439
- **Blogspam & Self Promotion** — You are allowed to post blogs and self promotional material provided it is not clearly spam and offers something to the sub. Please consider the spam rules on reddit when posting and make sure you follow the 9:1 rule. https://www.reddit.com/wiki/selfpromotion
- **No referral/affiliate-links.** — We're not here to generate money for you. This will be an immediate ban, no questions asked. Part of this rule will include blocking URL shorteners.`,

	claudeai: `- **Be respectful** — Diversity of opinion is welcome. Controversial opinions are welcome. Personal attacks and harassment are not. Ask Claude for a definition of "good faith discussion for a subreddit" if you're unsure what's acceptable.
- **Be relevant** — Stay relevant to the Claude and Claude Code technology and users. We generally don't accept posts of more general AI interest here.
- **Be constructive. Don't come here to agitate others.** — Is your post/comment likely to add positively to the knowledge or experience of other readers here? Has it already been shared recently? Is it just designed to agitate others? Cancellation announcements and unsupported rants are not constructive. We also do not allow the organization of legal action on the subreddit.
- **Use the Megathreads for your recent Claude performance and bug reports/complaints** — Help us keep track of Claude system performance, limits and bugs by keeping your experiences and reports on the relevant Megathread https://www.reddit.com/r/ClaudeAI/comments/1s7fepn/rclaudeai_list_of_ongoing_megathreads/. This also frees the feed from performance incident flooding. We make occasional exceptions for well substantiated and helpful posts including useful questions. Check first if your issue has been discussed recently.
- **Do not come here to fix your Anthropic account problem** — Community replies to individual account issues have often caused confusion. We have no way of fixing the problem with your account and Anthropic does not respond to account help requests on this subreddit. Try their normal support channels. If you believe you were incorrectly charged, talk to your bank about a chargeback.
- **Competitor posts must contain sufficient homework and evidence.** — Competitor posts must satisfy ALL of the following criteria: a) cannot merely ask for a comparison without offering the author's own insights, research, genuine experiences, or evidence of investigation; b) cannot presume one model is better than another without providing detailed, novel evidence demonstrating this in specific instances; c) cannot cite comparative benchmarks without a source d) it cannot use inflammatory language. Basically you have to give before you can take.
- **Showcase your project in a way that helps educate and inspire others** — Promoting your project or paid service is encouraged if it fit the following criteria: be clear the project was built with Claude/Claude Code or specifically for Claude BY YOU include a clear description of what was built, how Claude helped, and what it does project must be free to try and say so (paid tiers/features OK) promotional language minimal do not use referral links (link to the project is ok) no job seeking requests or resumes Posts on the feed now require OP karma> 50
- **Read the Megathreads before you subscribe to Claude** — We strongly advise you visit the Performance Megathread before purchasing a plan. It is here https://www.reddit.com/r/ClaudeAI/comments/1s7fepn/rclaudeai_list_of_ongoing_megathreads/. Be aware of some of the issues you may face. Claude is a fast evolving technology.
- **Use relevant post flair** — Claude has vast amounts of diverse use cases. As a result, often the problems/questions/praise you have for Claude are not shared by others. Help others filter posts by their area of interest by choosing the flair most related to its usage group. If none fit, or you feel it is of more general interest, choose the flair most relevant.
- **Don't manipulate upvotes** — Undermining the Reddit voting system is an immediate permanent ban offence. This includes the use of bots. This subreddit has bots in place looking for suspicious activity.
- **Stay grounded** — If you post narratives about AI consciousness and experiences, they must be based in grounded research with references OR be clearly marked in the title as fiction to avoid misguiding people in vulnerable mental states AND use the Writing flair.
- **Be Reddit-compliant** — This subreddit uses Reddit's default harassment and abuse filters. In addition, you may find yourself or your content removed by Reddit if you don't follow their policies. These can be found below. Reddit content policy: https://www.redditinc.com/policies/content-policy Those discussing the use of Claude for creative writing should pay particular attention to Rules 6, 7 and 4. Reddit user agreement: https://www.redditinc.com/policies/user-agreement-september-25-2023`,

	mcp: `- **No waitlists** — If you are working on a service, you are welcome to share it with the community after its fully launched. To combat spam, we don't allow links to announcements of future-services until they are barely anything more than a landing page.
- **No AI generated slop** — There has been a wave of AI-generated slop used to promote random services, usually disguised as sensational topics like MCP security. Such content will result in a ban.
- **No astroturfing** — Self-promotion is allowed with proper disclosure. Anyone caught promoting their product while pretending to be an unaffiliated user will be permanently banned.
- **Use showcase tag to share your work** — If you've built something in the MCP ecosystem, use showcase tag to indicate authorship and intent of demonstrating your work to others.`,

	openclaw: `This community publishes no rules.`
};

// The canonical key of a subreddit name — how SUBREDDITS is keyed, so any spelling a caller has
// ("r/AI_Agents", "AI_Agents") finds the same community. The twin of threadUrl's normalization.
export const subKey = (subreddit: string): string => subreddit.replace(/^r\//i, "").toLowerCase();

// Our own Reddit username: `queue` never backlogs our own threads (you don't reply to yourself).
// Empty ⇒ the check is off until filled in.
export const OWNER: string = "Separate-Still3770";

export default {
	destination: "notion",
	models: {
		RedditThreads: "287eec98-859f-4a64-a50d-75da2e965488",
		RedditBacklog: "ba8786a2-afd6-4b12-8416-df2a85440f58",
		Decisions: "eddcfaaf-e6f1-4cea-a112-2b9d98426eb4",
		Prompts: "942c4138-c9db-404c-9ae0-472f8edb0712"
	},
	// The Backlog, not the Thread: a Decision binds to the OUTREACH it advances, and the thread is
	// merely what that outreach is about. A thread we have never engaged has no row here at all.
	entity: "Reddit Backlog",
	// Flash, not Sonnet: the judgments here are cheap relevance gates ahead of a human review, the
	// fan-out is wide, and this account's Bedrock TPS throttles at even 2 concurrent (measured).
	model: "google/gemini-3.5-flash",
	// The Backlog's ladder — the OUTREACH's states, and there are only two live ones because
	// approving a reply and posting it are one act (`reply.act`), not an intent and a later deed.
	// A thread's own progress is not here and never was a ladder: it is the Tier column, which is
	// empty until it is judged.
	//
	// It reads as a cycle, and the two directions have different owners. FORWARD is the review app's
	// commit, which this list governs — `ahead()` refuses to regress a row, so a stale re-confirm
	// cannot undo a move that already happened. BACKWARD, to "Pending approval", is the RUNTIME
	// minting the next Decision once the OP has answered (`linkEntity`), which `ahead` does not
	// govern — deliberately: at most one Decision is ever open on a Backlog row, so there is no
	// second writer to race. "Dropped" is off the ladder: terminal, the sweep's verdict.
	ladder: ["Pending approval", "Waiting for OP"],
	prompts: {
		// Is this thread worth answering? The one filter of the funnel (no deterministic pre-filter),
		// and NOT a human gate: it is calibrated against reddit_qualified_threads.yaml, so the funnel
		// judges it and keeps only the verdict (the Tier column and a comment on the thread page). No
		// `pending` for the same reason — there is no gate to park anything at, and there is no
		// Backlog row yet either: a thread that fails here never becomes an outreach.
		//
		// Only `advances` is read (tools.ts writes the Tier itself), so `status` carries the Tier
		// rather than a rung name — naming a rung that no table has would be fiction.
		qualify: {
			name: "Reddit Thread Qualification",
			resolve: (o) => ({ status: String(o.tier ?? ""), advances: o.tier !== "No" })
		},
		// The reply — the ONE Decision this agent creates, because it is the one thing a human rules
		// on. The committed output IS the decision, and here it is also the DEED: `act` posts it, then
		// `resolve` lands the row at "Waiting for OP" — one click, one write, no state in between for
		// something else to have to drain. No negative branch: declining to engage is not confirming.
		reply: {
			name: "Reddit Reply",
			pending: "Pending approval",
			resolve: (_output) => ({ status: "Waiting for OP", advances: true }),
			// Post the approved reply, and hand back what proves it happened.
			//
			// Idempotent on the DATUM, never on a rung: `Comment URL` holds what we posted, so a
			// re-confirm of a decision already acted on returns null and writes nothing. That check is
			// what makes the review app's Confirm safe to click twice — and it is a fact about the
			// world, not a bookkeeping flag, so it stays true however the row got where it is.
			//
			// One branch today, because there is one conversation shape today: nothing of ours under
			// the post yet ⇒ a top-level comment. Continuing a conversation the OP has answered is
			// `answer(permalink, …)`, and it lands here — with the permalink it replies to — the day
			// the follow-up sweep exists to notice that they answered.
			act: async (output, entity) => {
				// Already posted ⇒ nothing to do, and nothing to validate either: the guards below judge
				// text we are ABOUT to send, and this text is already on Reddit. Ordering matters — put a
				// content rule first and a re-confirm of a posted reply would fail on words the world has
				// long since accepted.
				if (entity["Comment URL"]) return null;
				const text = String(output.reply ?? "").trim();
				if (!text) throw new Error("the committed reply is empty — nothing to post");
				const url = entity["Thread URL"];
				if (!url) throw new Error("this outreach has no Thread URL — cannot post");
				// NO LINKS. Measured, on this very reply: r/automation's composer never enables its
				// Comment button while the body carries a URL, so the run types the text and then waits
				// out its timeout with nothing submitted — a failure that costs a browser minute and
				// reports itself as a timeout rather than as the rule it hit. (The identical text posted
				// fine in r/test, so this is the COMMUNITY's restriction — r/automation bans link posts
				// outright — not Reddit's, and not something the page tells us before we try.)
				//
				// So refuse here, where the reviewer is still looking at the draft and one edit fixes it.
				// It is deliberately blunt — any URL, every subreddit — because the alternative is
				// guessing per community which links are tolerated, and being wrong costs a ban rather
				// than a retry. A link that genuinely belongs (r/AI_Agents asks for them in comments) is
				// a reason to scope this per subreddit against SUBREDDITS above, not to drop it.
				const link = text.match(/\b(?:https?:\/\/|www\.)\S+/i);
				if (link)
					throw new Error(
						`the reply carries a link (${link[0]}) — Reddit will not let it be submitted here. ` +
							`Edit the draft to say it in words, or point them at the name and let them search.`
					);
				const { permalink } = await say(threadUrl(url), text);
				return {
					"Comment URL": permalink.startsWith("http")
						? permalink
						: `https://www.reddit.com${permalink}`,
					"Posted at": new Date().toISOString()
				};
			}
		}
	}
} as const satisfies AgentConfig;
