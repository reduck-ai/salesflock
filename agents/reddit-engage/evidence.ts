// reddit-engage's evidence renderer — the agent OWNS its rendering (one file, imported by BOTH
// consumers: the runtime judge in tools.ts and the review app via $agent/evidence, so they can
// never render differently): the generic seam
// (renderEvidence + fieldSpan) plus the one display decision — the frozen Thread YAML rendered as
// a Reddit-style thread: title + meta header, the OP's body verbatim and prefix-free so a judge's
// quote anchors on it, then a divider and the comments as cards, each carrying its depth. The
// document's ONE structural rule, which both readers get from the same emission: unwrapped prose is
// the OP's post — the voice a reply answers — and anything in a card is somebody else. A Decision
// freezes the Input MAP, so improving this renderer reflows every Decision on read — no re-judge.

import { parse } from "yaml";
import { markdown } from "../../src/markdown.js";
import type { Quote } from "../../src/anchor.js";

const dot = (...parts: (string | number | false | null | undefined)[]): string =>
	parts.filter((x) => x || x === 0).join(" · ");

// The frozen Thread YAML `engage` writes: the full thread, OP + comments.
interface ThreadSeed {
	subreddit?: string | null;
	url?: string | null;
	title?: string | null;
	author?: string | null;
	created?: string | null;
	score?: number | null;
	num_comments?: number | null;
	op_text?: string | null;
	comments?:
		| {
				author?: string | null;
				body?: string | null;
				score?: number | null;
				depth?: number | null;
		  }[]
		| null;
}

// The frozen Thread YAML parsed, or null when the field isn't the shape `engage` freezes (then the
// generic Markdown fallback applies). One parse, shared by the card body and the section heading.
const threadOf = (yaml: string): ThreadSeed | null => {
	try {
		const t = parse(yaml) as ThreadSeed | null;
		return t && typeof t === "object" && typeof t.title === "string" ? t : null;
	} catch {
		return null;
	}
};

// Reddit's scrape indents every paragraph after the first (six spaces — measured on 290 of the 423
// stored threads), and four spaces IS a markdown code block: the OP's prose was rendering as
// monospace slabs, to the judge as much as to the reviewer. So drop exactly the indentation that
// would open one — four or more spaces, or a tab. Not the *common* indent: the first paragraph
// comes back flush, which makes the common indent zero and would fix nothing.
//
// Shallower indentation survives, so a nested list still nests, and a fenced ``` block is a fence
// rather than an indent, so real code the OP fenced still renders as code. Indent-style code blocks
// are the one casualty — and they are indistinguishable from the artifact by construction.
const dedent = (text: string): string =>
	text
		.replace(/[ \t]+$/gm, "")
		.replace(/^(?: {4,}|\t+)/gm, "")
		.trim();

// The instant, readable and DETERMINISTIC: "2026-07-31 19:24 UTC". Never relative ("2 days ago") —
// this render IS the anchor space every committed quote indexes into, so a value that moved with
// the clock would silently shift every offset in the document on each read.
const when = (iso?: string | null): string =>
	iso && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)
		? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
		: (iso ?? "");

// NB — the head is HTML, but the seed's own text goes in RAW, deliberately: this render IS the
// anchor space, and `canonicalize` (src/anchor.ts) strips tags without decoding entities. So an
// escaped title ("Mouse &amp; Keyboard") no longer matches what the model quotes or what a human
// selects in the DOM — measured: 3 of 423 titles carry `&` or `>`. The rule this file obeys:
// E is text plus tags, never entities. Untrusted markup is a real concern, and it is the whole
// document's (the body is Reddit's markdown, unescapable without destroying it) — so it belongs at
// the ONE place HTML becomes DOM, the app's `{@html}` boundary, not in one agent's title.

// A comment as a CARD: the byline, then the reply's own markdown, wrapped in the agent's own tag.
// Unwrapped prose is the OP's post — the one voice a reply answers; anything in a card is somebody
// else. That is the whole delimitation, and it is made ONCE for two readers who need it in
// different places: the JUDGE reads this markdown, so the boundary is in the TEXT (the wrapper tag
// and the byline that opens it); the REVIEWER reads the DOM, so it is also a class the skin draws
// (evidence.css). `canonicalize` strips tags, so neither reader's marker costs the anchoring layer
// anything — and this is the rd-head idiom a third time: an HTML block (byline inside it, no blank
// line), a blank line handing the body back to markdown, then the closing tag as its own block.
// Exactly the shape `<details class="fold">` uses below. One idea, three uses.
//
// The `> ` prefixes this replaces were the same intent one layer too low: markdown has no class to
// hang a skin on (the app styles no blockquote at all, so the cards rendered as flat prose), the
// prefix had to be spliced into every line of the body, and a comment that itself quotes the OP —
// which is how Reddit argues — became indistinguishable from our own framing. Now `>` in this
// document means only what the commenter meant by it, and the body is the same plain text the OP's
// is, so a multi-line quote anchors identically in both.
//
// `depth` rides as an attribute rather than as indentation: the model reads the number, the CSS
// reads the same number. One datum, no second encoding to keep in sync — and it is CLAMPED here
// rather than in the skin, because a cap the CSS applies by omission is not a cap: a depth the
// stylesheet has no rule for falls back to flush-left, rendering the deepest reply in the tree as
// if it were a top-level one. Four levels is what Reddit itself indents to, and past that "who
// answered whom" is not what the card is carrying anyway.
//
// The OP's OWN replies are marked, and they are why the comments are fetched at all: what someone
// volunteers under their post is theirs as much as the post is, and it is routinely the opposite of
// what the post implies ("I'm a broke student" under a post that reads like a funded project). The
// marker is `<b>`, which the head's byline already uses for "the thing that matters in this line" —
// so the skin highlights it for free, and the judge reads the word "(OP)".
const renderComment = (
	c: NonNullable<ThreadSeed["comments"]>[number],
	op?: string | null
): string => {
	const who = c.author ?? "[deleted]";
	const isOp = !!op && who === op;
	const byline = dot(
		isOp ? `<b>u/${who} (OP)</b>` : `u/${who}`,
		c.score != null && `${c.score} points`
	);
	// dedent for the same reason the OP's body needs it — Reddit's scrape indents every paragraph
	// after the first, and four spaces IS a code block, so the reply renders as a monospace slab.
	return [
		`<div class="rd-comment${isOp ? " rd-op" : ""}" data-depth="${Math.min(4, Math.max(0, c.depth ?? 0))}">`,
		`<span class="rd-meta">${byline}</span>`,
		``,
		dedent(c.body ?? "(no text)"),
		``,
		`</div>`
	].join("\n");
};

// The thread as Reddit lays it out: a HEAD — title, then a meta line led by the community — and
// under it the OP's body, plain (quotes anchor on it) and still markdown. The head is one raw-HTML
// block with no blank line inside it, because a blank line is what closes an HTML block: the blank
// line after `</div>` is precisely what hands the document back to markdown for the body. Same
// trick as a comment card above and the folded section below. The classes are the agent's own skin
// (evidence.css); `canonicalize` strips the tags, so a quote anchors straight through them.
// NB: any change ABOVE the body shifts every committed Decision's quote offsets — that needs a
// re-anchoring migration, not just this file.
const renderThread = (yaml: string): string => {
	const t = threadOf(yaml);
	if (!t) return markdown(yaml);
	const meta = dot(
		t.subreddit && `<b>r/${t.subreddit}</b>`,
		t.author && `u/${t.author}`,
		when(t.created),
		t.score != null && `${t.score} points`,
		t.num_comments != null && `${t.num_comments} comments`
	);
	const head = `<div class="rd-head">\n<span class="rd-title">${t.title ?? "(untitled)"}</span>\n<span class="rd-meta">${meta}</span>\n</div>`;
	// The rule between the post and the discussion — the one line that says "the OP has stopped
	// speaking". It is a labelled divider rather than a bold pseudo-heading for the same reason the
	// cards are cards: a class the skin can draw a hairline across, and a sentence the judge can read.
	const divider = (label: string): string => `<div class="rd-divider">${label}</div>`;
	// The two negatives stay distinct, and the EVIDENCE says which — the same rule config.ts's
	// SUBREDDITS obeys ("this community publishes no rules" in words, versus a subreddit that was
	// never derived and is simply absent). An absent `comments` key means nobody has fetched the
	// page: the document says nothing, because nothing was looked at. An EMPTY one means we looked
	// and the thread is silent — a fact, and a loud one for this agent (an unanswered question is
	// the best thing a reply can find), so it is stated. `hasCommentTree` draws this same line for
	// the funnel; without it here the judge is the one reader who cannot tell the two apart.
	const comments = !t.comments
		? []
		: t.comments.length
			? [
					divider(
						`Comments${t.num_comments && t.num_comments > t.comments.length ? ` · ${t.comments.length} of ${t.num_comments} shown` : ""}`
					),
					...t.comments.map((c) => renderComment(c, t.author))
				]
			: [divider("No comments — nobody has replied to this post")];
	return [head, dedent(t.op_text || "(no text)"), ...comments].filter(Boolean).join("\n\n");
};

// Per-field renderer: Thread mirrors Reddit; the community's rules are authored as markdown in
// config.ts, so they pass through verbatim rather than round-tripping through the generic YAML
// pass — which would only leave them intact by accident. Everything else is generic.
const renderers: Record<string, (v: string) => string> = {
	Thread: renderThread,
	"Subreddit rules": (v) => v
};
const render = (k: string, v: string): string => (renderers[k] ?? markdown)(v);

// A field's section heading. The Thread heading IS the link to the thread (its canonical URL rides
// in the seed).
const heading = (k: string, v: string): string => {
	const url = k === "Thread" ? threadOf(v)?.url : undefined;
	return url ? `### [${k}](${url})` : `### ${k}`;
};

// Fields that ship FOLDED — reference the judgment must obey but a reviewer reads once: shown as a
// disclosure, closed by default, so the thread stays the document and the rules stay one click away.
const FOLDED = new Set(["Subreddit rules"]);

// A section, as its three parts: everything before the content, the content, everything after. The
// ONE declaration of a section's shape — renderEvidence joins the parts, fieldSpan measures them,
// so the text and the offsets into it cannot drift.
//
// A folded field is plain `<details>`, which costs the anchoring layer nothing: `canonicalize`
// (src/anchor.ts) strips HTML tags, so a quote resolves through a disclosure exactly as through a
// heading, and `highlight.ts` never lets a <mark> cross a tag. The blank line after `<summary>` is
// load-bearing — it closes the HTML block, so `marked` renders the rules as a real markdown list
// inside the disclosure rather than as raw text.
//
// The whole input is in scope because one section is ABOUT another: the rules govern a community,
// and the community is the Thread's, so the summary says whose rules these are — read from the seed
// that already holds it rather than stored a second time.
const section = (
	k: string,
	v: string,
	input: Record<string, string>
): [open: string, body: string, close: string] => {
	if (!FOLDED.has(k)) return [`${heading(k, v)}\n\n`, render(k, v), ""];
	const sub = threadOf(input.Thread ?? "")?.subreddit;
	const summary = sub ? `${k} · r/${sub}` : k;
	return [
		`<details class="fold">\n<summary>${summary}</summary>\n\n`,
		render(k, v),
		`\n\n</details>`
	];
};

// The lossless input map → one Markdown document, a section per field — verbatim values, so a quote
// resolves against it. The judge reads this as its prompt; the app renders the same from the frozen
// map. One renderer, every caller.
export const renderEvidence = (input: Record<string, string>): string =>
	Object.entries(input)
		.map(([k, v]) => section(k, v, input).join(""))
		.join("\n\n");

// fieldSpan(input, key) — the [start,end) of `key`'s rendered CONTENT within renderEvidence(input),
// derived from the very sections renderEvidence joins. How CODE, never the LLM, gives the composer
// its anchor: the span of the field the reply answers (the "Thread"). null when the field isn't
// present.
export const fieldSpan = (input: Record<string, string>, key: string): Quote | null => {
	const entries = Object.entries(input);
	const i = entries.findIndex(([k]) => k === key);
	if (i < 0) return null;
	const pre = entries
		.slice(0, i)
		.map(([k, v]) => section(k, v, input).join(""))
		.join("\n\n");
	const [open, body] = section(key, input[key], input);
	const start = (i ? pre.length + 2 : 0) + open.length;
	return { start, end: start + body.length };
};
