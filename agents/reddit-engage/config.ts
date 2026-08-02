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

	aiautomations: `This community publishes no rules.`,

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

	ecommerce: `- **No Soliciting, Promotion, or Direct Soliciting via DM** — No Self-Promotion: Do not solicit, promote, or attempt to acquire personal or private contact with users in any way (even if free). This includes soliciting posts, DM requests, invitations, referrals, or any attempt to initiate personal contact. This includes posts seeking services. Your post/comment will be removed, and you will be banned without warning. This is not the place to promote or seek out services in any way. This is our most strictly enforced rule.
- **No External Links (Except Site Reviews)** — Do not post links to services, blogs, videos, courses, or websites (see Section III for site review exceptions). Do not link to your YouTube, Twitter, Facebook, or other pages. Links to pages that address a specific issue may be allowed, but context may be reviewed by moderators.
- **No 3PL Related Threads** — These threads are repetitive and often promotional. Refer to previous threads or other subgroups.
- **No "Get Rich Quick", "Success Stories", Case Studies, etc** — No "Get Rich Quick", "Success Stories", Case Studies, or Blogspam Posts: Do not post "We turned $XXX into $XXX in 4 Weeks - Here's How," How-To Guides, "Top 5 Ways You Can..." lists, or other blogspam.
- **Do not post courses, themes, or stores for sale** — r/ecommerce is not the place to sell your existing ecommerce store, theme, account, or course. Users who violate this rule will be banned, due to the risk of fraud and dishonesty it causes. This included trade offers.
- **No 'Dev Research' posts** — Posts seeking "pain points," "biggest challenges", app validation ideas, beta testers, app reviews, or feedback on app/software ideas are not allowed
- **No AI or Suspected AI Slop** — Obvious or suspected AI content is not welcome here. Violations from lower-karma accounts with little contribution history in this sub may result in a ban. This will be at the sole discretion of the group moderators.`,

	hermesagent: `- **Respect others and be civil** — No harassment, hate speech, or toxic behavior. Treat all contributors and members with kindness. We have a mix of advanced developers and first-time local LLM users. Gatekeeping, elitism, or toxic behavior will result in a ban. Attack the problem, not the person.
- **No Spam, Soliciting, or Unapproved Selling** — No spam, soliciting, or unapproved selling — paid API access, closed-source wrappers, crypto, unrelated AI services. Sharing free open-source Hermes tools/skills is encouraged. Clickbait with generic advice applicable to any AI tool (no Hermes-specific detail, no code/screenshots/real workflow) is spam regardless of formatting.
- **The 90/10 Self-Promotion Guideline** — The 90/10 self-promo guideline — 1 showcase/promo post requires 9 prior community contributions. Posts framed as help/troubleshooting that recommend the author's own project/service count toward the 10% limit even if flaired differently. Repeat offenders face temporary ban. A compliant Contributor Footer under Rule 12 is permitted and does not, by itself, violate the 90/10 guideline.
- **Technical Help Requires Context** — Technical help requires context — include OS and version, Python version if applicable, GPU/hardware specs, local model setup (Ollama/oMLX), full error with stack trace, and what troubleshooting was already attempted before asking. "It won't install help!" is unintentional spam.
- **Keep It Relevant to Hermes Agent** — Posts must be directly related to Hermes Agent, its ecosystem, models that run well with it, or direct comparisons (e.g., Hermes vs. OpenClaw). General "AI news" or off-topic tech discussions will be removed.
- **Context Required in Posts & Reports** — Don’t post random screenshots, photos, or reposts without explanation. Add relevant details, findings, or discussion points.
- **Keep Politics to a Minimum** — r/hermesagent is a tech-focused community. Political discussion is welcome when it directly impacts the Hermes Agent ecosystem (e.g., AI regulation, open-source policy, provider bans affecting users). General political posts, geopolitical debates, or tangential chain-reaction threads (e.g., company partnerships with other companies linked to a country or cause) should be kept minimal or flaired as discussion. The focus here is the tool, not the world stage.
- **Cross-Post Limit** — Same or nearly identical title/content to 3+ subs within 24 hours = auto-remove. Identical copy/paste across subs is removal regardless of count — adapt each post for that community.
- **New Account Post Approval** — Accounts created within the last 30 days with fewer than 50 total karma across Reddit must have all posts approvedby mods before they appear. Established accounts (30+ days, 50+ karma) may post freely.
- **Constructive Discussion** — Comments should add value — ask questions, share experience, or offer solutions. Vague complaints, one-liner dismissals, and dramatic takeaways without specifics are fair game for removal. Posts must state what troubleshooting steps were attempted and documentation consulted before asking the community. First-time offenders get an automod reply pointing to docs; repeat bad-faith posts removed.
- **Moderator Discretion** — These rules serve as a guide to maintain subreddit quality. Posts or comments may be removed at moderator discretion if they violate the spirit of these rules, harm community experience, or fall into gray areas not explicitly covered. Moderators reserve the right to act in the best interest of the community beyond what is written here.`,

	inventorymanagement: `- **Do not post promotional content** — Do not link to your YouTube, Twitter, FB, or other pages. The sub exists to help others, not to help you get likes or subs. Keep all conversation pertaining to the post here so that everyone may benefit from the conversation.
- **Soliciting, Self-Promotion, or Direct Soliciting via DM** — The purpose of making a submission or comment is to engage in a public discussion with the community. It is not to request a PM/DM from someone. Do not post a notice that you DMed someone. You are more than welcome to engage privately with one another, but it is up to you to take the initiative directly.
- **Do not link to sites or blogs within your post** — Do not post a link to a service / blog / video / or website.
- **Be polite and helpful** — At all times be civil and constructive.
- **Do not post courses or templates for sale** — is not the place to sell courses or templates. Users who violate this rule will be banned, due to the risk of fraud and dishonesty it causes.`,

	mcp: `- **No waitlists** — If you are working on a service, you are welcome to share it with the community after its fully launched. To combat spam, we don't allow links to announcements of future-services until they are barely anything more than a landing page.
- **No AI generated slop** — There has been a wave of AI-generated slop used to promote random services, usually disguised as sensational topics like MCP security. Such content will result in a ban.
- **No astroturfing** — Self-promotion is allowed with proper disclosure. Anyone caught promoting their product while pretending to be an unaffiliated user will be permanently banned.
- **Use showcase tag to share your work** — If you've built something in the MCP ecosystem, use showcase tag to indicate authorship and intent of demonstrating your work to others.`,

	n8n: `- **No Spam & No Clickbait** — You are welcome to post often! Ask for help, share templates, and contribute to the community. But excessive posting, misleading titles, or repetitive content may be removed.
- **No AI Slop** — No AI Slop
- **No Self-Promotion or Advertising** — Do not promote your own tools, SaaS products, paid services, courses, or platforms. If you built something with n8n and want to share it, use the Workflow - Github Included flair and include the code. Posts that exist primarily to drive traffic to your product or service will be removed.
- **No Business, Agency, or Client-Related Posts** — This is a technical subreddit focused on building with n8n — not on how to monetize it. Posts about starting an agency, finding clients, pricing your services, business models, or "how do I sell automation" are off-topic. We encourage users interested in the business side to head over to subreddits dedicated to entrepreneurship, freelancing, or consulting.
- **No Links to Paid Workflows, Paid Communities, or Signup-Required Content** — This includes but is not limited to Gumroad, Skool, paid Discord servers, and communities that are free to join but require a signup. No "DM me for workflow," no "comment here for the link," no email signups for templates. If you're sharing a workflow, share it publicly using an approved method.
- **Recruiting and Hiring** — You must share your Company Name and Website. If you do not have a company or website, you must include your LinkedIn profile. If there is a reason you can't do this publicly, message the mods for approval. A project description is required — low effort on this piece could lead to removal of the post.
- **All Workflow and Video Posts Must Include the Code** — If you're sharing a workflow — whether as a post, screenshot, or video — the code must be included directly in the Reddit post. Acceptable ways to share: Github Repository, Github Gist, n8n.io/workflows/. Sharing the code any other way is not allowed. Posts without a link to the code will be automatically removed. Screenshots alone do not count.
- **No Google Drive or Google Docs Links** — Google links frequently become inaccessible or require permissions that make them unreliable for the community. Use one of the approved sharing methods listed in Rule 6 instead.
- **Use the Correct Post Flair** — All posts must use the appropriate flair. Posts that use the wrong flair to sidestep rules (e.g., posting a workflow under Meta/News to avoid code-sharing requirements) will be removed.
- **Low Quality or Off Topic** — Low quality and off-topic posts are subject to removal at moderator discretion.
- **Keep it civil** — Be respectful. No personal attacks, harassment, or hostile behavior.`,

	openclaw: `This community publishes no rules.`,

	webscraping: `- **Open Discussions** — Ensure discussions remain public to benefit the entire community
- **Self-Promotions** — Refer to the wiki for detailed guidelines on promoting services or products
- **Commercial Products** — Refrain from referring to commercial products or services, including proxy vendors and products with free tiers`,

	woocommerce: `- **Absolutely no promotional material in posts** — POSTS — Promotional posts are NEVER ALLOWED. This includes advertisements, self-promotion, or any content intended to market or sell a product, service, or website. Affiliate, referral, or monetized links are never allowed. COMMENTS — Recommendations, references, and links are ALLOWED when they directly help answer the original post. However, overly promotional comments may be removed at our discretion. Affiliate, referral, or monetized links are never allowed.
- **No off-topic posts** — This subreddit is focused on WooCommerce, its features, integrations, and best practices. Please ensure that all POSTS and COMMENTS are related to WooCommerce. Off-topic content, including posts about unrelated platforms or general ecommerce topics, may be removed to keep the community focused and helpful. Discussions about WooCommerce and how it compares to other platforms are permitted and encouraged, as long as WooCommerce remains the focus.
- **Be friendly** — This is a place for friendly discussions. Please be kind to each other and to the open source ecosystem that makes WooCommerce possible. Discussions that are unhelpful, unconstructive, or detrimental to the community or ecosystem aren't welcome here. Being friendly means being respectful and helpful to community members, supporting the developers and maintainers who keep the ecosystem alive, and sharing advice that's accurate, thoughtful, and useful.
- **No solicitation or hiring requests** — We do not allow posts requesting paid services, offering payment for work, or soliciting developers for hire. This includes but is not limited to job postings, freelance requests, bounties, or any form of monetary exchange. This rule helps protect our community from potential scams and keeps the focus on helpful, educational discussions about WooCommerce. For hiring developers, consider platforms like r/forhire, r/WordPressDev, Upwork, Fiverr, or Codeable.
- **Relevant recommendations (comments only)** — We encourage sharing helpful plugins, services, or solutions that extend WooCommerce's functionality — including your own if they are genuinely relevant. Recommendations must be made in response to a specific question or discussion in the comments and must directly address the user's needs. Promotional content in posts is not permitted. Links are allowed but may be held for moderation. Affiliate links and links to low-quality or untrustworthy websites are not permitted.
- **Lead Gen / Data Harvesting** — Absolutely no posts on lead gen, data harvesting, surveys, or research unless they are directly tied to Woo with clear Woo-specific data or use cases. Any attempt to harvest data from users will be removed.`,

	wordpress: `- **No promotions of products or services** — We do not allow posts or comments intended for promotion or advertising. These will be removed. Sharing free open-source products/services/projects via Wordpress.org or Github, that are useful to the community, are permitted, once, as long as they don't break any other rule. Your post title must start with [PROMO] or it will be removed. Paid plugins that offer a free trial are not allowed. If you are wanting to promote your plugin, you can do so over in r/wordpressplugins
- **No List posts: eg. Your favorite plugins, Top 10 Plugins, Top 10 Themes** — Try r/WordpressPlugins and r/WordPressthemes instead. These posts are typically used by people to promote their products.
- **No URL shortening services** — Don't use bitly or similar when posting links or links within comments.
- **Posts must be related to WordPress** — Posts must be related to WordPress. Links to your blog/website, or talking about blogging, are not relevant to this subreddit. If your hosting is with Wordpress.com, you need to go through them for support at https://wordpress.com/support. Wordpress.com features are often different to Wordpress.
- **No nulled software posts or discussions** — Discussion of so-called 'nulled' software is not allowed in this sub. While some of the software may be "technically legal" due to the nature of the GPL, it is not considered ethical. For more info, please see our "Essential Resources" guide.
- **No abusive language, harassment or bullying towards anyone. Be respectful.** — Criticising or discussing someone's actions is fine, but if your comment is simply a derogatory insult with no constructive input, it will be removed. Abusive language, harassment, or bullying directed at anyone is not allowed and will result in your post or comment being removed. A temporary ban may be issued at the mod's discretion, and repeated violations will result in a permanent ban.
- **Do not duplicate on-going discussions** — Please avoid making new posts if they largely duplicate ongoing discussions. For example, if you're discussing the same tweet, please keep it to one post. A quick search can often help find an existing post to join. If there's a new development on a situation, however, a fresh post is welcome.
- **No affiliate links** — No affiliate links in posts or comments, or links to articles that contain affiliate links.
- **No low effort posts** — Lazy posts that just link to external sites (either directly or by crossposting to another subreddit) without any context will be removed. Add your opinion, or a summary of the content, and try to start a conversation.
- **No hosting discussions** — Please refer to historic posts within this subreddit for recommendations, or ask in r/webhosting.
- **No site critique requests** — Sorry, we don't allow posts asking for feedback/site critiques. Just because your site is built with Wordpress does not mean your post is related to Wordpress. For design critique, post in r/web_design
- **No job ads** — Sorry, we don't allow job ads Including "looking to hire", "looking for work", "how to find clients". Post in r/forhire or r/forhirefreelance or r/wordpressjobs
- **No "how much to charge / how to find clients" questions** — Everyone has wildly different prices based on country and experience. Posts about pricing won't get you the answer you're looking for. Methods for finding clients can be found all over reddit and Google. Try r/forhire, r/freelance, or read this guide https://pricingdesignbook.com/
- **Spam** — Junk that doesn't belong here in this sub, or on Reddit: karma farming, AI-generated content, astroturfing, non-genuine content, etc.`
};

// The canonical key of a subreddit name — how SUBREDDITS is keyed, so any spelling a caller has
// ("r/AI_Agents", "AI_Agents") finds the same community. The twin of threadUrl's normalization.
export const subKey = (subreddit: string): string => subreddit.replace(/^r\//i, "").toLowerCase();

// Our own Reddit username — the account DEVICES.write is signed in as (keep the two in step, and
// see the note there for why nothing can check that for you). `queue` never backlogs our own threads
// (you don't reply to yourself). Empty ⇒ the check is off until filled in.
export const OWNER: string = "Separate-Still3770";

// WHICH paired browser does what — read on one account, write on another, because a browser IS an
// identity and the two jobs have opposite risk profiles. Scraping is high-volume and its worst case
// is a rate-limit or a shadowban; posting is low-volume under the one name that has to keep being
// welcome in these communities. Splitting them means no amount of reading can cost us the account
// that replies.
//
// Declared here, beside OWNER, because these are OUR accounts: the reduck client takes a device per
// call but cannot know which is which (core must not import an agent), and the read/write line it
// DOES own is exactly this line — `say`/`answer` are the writes, everything else reads. Passed
// explicitly at each call site rather than registered into the client once: a module-level default
// would be order-dependent, and losing that race means a reply posts under the reading account.
//
// The ids come from `reduck list_devices`; WHO each one is comes from
// `reduck run --script reduck/reddit.com/whoami` on it. Nothing checks that write is still OWNER —
// signing that browser into a different account silently changes who we are, so verify after any
// re-pair or re-login. (Measured, the hard way: both devices were throwaway accounts for an
// afternoon while this file claimed otherwise.)
export const DEVICES = {
	read: "4ff47fc1-c4db-4710-aaed-ece4c8636707",
	write: "e87f7b96-4ce6-401a-bfbe-b8773060b788"
} as const;

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
				// DEVICES.write — the one account whose name belongs on a reply (OWNER's).
				const { permalink } = await say(threadUrl(url), text, DEVICES.write);
				return {
					"Comment URL": permalink.startsWith("http")
						? permalink
						: `https://www.reddit.com${permalink}`,
					"Posted at": new Date().toISOString()
				};
			}
		},
		// The SCORER — the only prompt here that judges nothing about Reddit and everything about us:
		// its Input is `reply`'s Input PLUS `reply`'s Output, and it rules whether that draft obeys
		// the rules the reply prompt states. Free text cannot be scored by `===`, and the alternative
		// to a prompt is a hand-written checker that drifts from the instructions it checks; a Prompt
		// row is versioned, fingerprinted and authored in the same loop as the thing it grades.
		//
		// No `pending`, no `resolve`, no `act`: it moves no pipeline, mints no Decision and is never
		// confirmed. It exists only for `sflock eval`. That absence is load-bearing — it is what keeps
		// this kind out of the review app's filter (agents/index.ts `KINDS`).
		//
		// Its ground truth is the review history itself: a Decision that was overturned yields a PAIR
		// on one thread — the committed text is a positive, the draft it replaced a negative — same
		// evidence, opposite verdict, which is the sharpest case a binary judge can be held to.
		judge: { name: "Reddit Reply Judge" }
	}
} as const satisfies AgentConfig;
