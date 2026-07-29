// reddit-engage's evidence renderer — the agent OWNS its rendering (one file, imported by BOTH
// consumers: the runtime judge in tools.ts and the review app via $agent/evidence, so they can
// never render differently). The Reddit sibling of lk-engage/evidence.ts: the generic seam
// (renderEvidence + fieldSpan) plus the one display decision — the frozen Thread YAML rendered as
// a Reddit-style thread: title + meta header, the OP's body verbatim and prefix-free so a judge's
// quote anchors on it, then the comments as blockquoted cards nested by depth (the
// src/linkedin/activity.ts idiom: anyone else's words are a quoted card). A Decision freezes the
// Input MAP, so improving this renderer reflows every Decision on read — no re-judge.

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
	comments?: { author?: string | null; body?: string | null; score?: number | null; depth?: number | null }[] | null;
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

// A comment as a blockquoted card nested by depth — `> ` per level, +1 so even a top-level comment
// is visibly not the OP's words (unquoted = the OP's, the one voice a reply answers).
const renderComment = (c: NonNullable<ThreadSeed["comments"]>[number]): string => {
	const prefix = "> ".repeat((c.depth ?? 0) + 1);
	const header = dot(`**u/${c.author ?? "[deleted]"}**`, c.score != null && `${c.score} points`);
	return [header, ...(c.body ?? "(no text)").split("\n")].map((l) => `${prefix}${l}`).join("\n");
};

// The thread as Reddit lays it out: title + meta, the OP body PLAIN (quotes anchor on it), then
// the comments. NB: any change ABOVE the body shifts every committed Decision's quote offsets —
// that needs a re-anchoring migration, not just this file.
const renderThread = (yaml: string): string => {
	const t = threadOf(yaml);
	if (!t) return markdown(yaml);
	const meta = dot(
		t.subreddit && `r/${t.subreddit}`,
		t.author && `u/${t.author}`,
		t.created,
		t.score != null && `${t.score} points`,
		t.num_comments != null && `${t.num_comments} comments`
	);
	const comments = t.comments?.length
		? [`**Comments${t.num_comments && t.num_comments > t.comments.length ? ` (${t.comments.length} of ${t.num_comments} shown)` : ""}**`, ...t.comments.map(renderComment)]
		: [];
	return [`**${t.title}**`, meta, t.op_text || "(no text)", ...comments].filter(Boolean).join("\n\n");
};

// Per-field renderer: Thread mirrors Reddit; everything else is generic Markdown.
const renderers: Record<string, (v: string) => string> = { Thread: renderThread };
const render = (k: string, v: string): string => (renderers[k] ?? markdown)(v);

// A field's section heading. The Thread heading IS the link to the thread (its canonical URL rides
// in the seed). One helper, used by renderEvidence AND fieldSpan, so their offset math can't drift.
const heading = (k: string, v: string): string => {
	const url = k === "Thread" ? threadOf(v)?.url : undefined;
	return url ? `### [${k}](${url})` : `### ${k}`;
};

// The lossless input map → one Markdown document, a `### field` section each — verbatim values, so
// a quote resolves against it. The judge reads this as its prompt; the app renders the same from
// the frozen map. One renderer, every caller. (The Reddit twin of lk-engage's renderEvidence.)
export const renderEvidence = (input: Record<string, string>): string =>
	Object.entries(input)
		.map(([k, v]) => `${heading(k, v)}\n\n${render(k, v)}`)
		.join("\n\n");

// fieldSpan(input, key) — the [start,end) of `key`'s rendered CONTENT within renderEvidence(input),
// derived from the very sections renderEvidence joins (same `render`, same `\n\n` join — they can't
// drift). How CODE, never the LLM, gives the composer its anchor: the span of the field the reply
// answers (the "Thread"). null when the field isn't present.
export const fieldSpan = (input: Record<string, string>, key: string): Quote | null => {
	const entries = Object.entries(input);
	const i = entries.findIndex(([k]) => k === key);
	if (i < 0) return null;
	const pre = entries
		.slice(0, i)
		.map(([k, v]) => `${heading(k, v)}\n\n${render(k, v)}`)
		.join("\n\n");
	const start = (i ? pre.length + 2 : 0) + `${heading(key, input[key])}\n\n`.length;
	return { start, end: start + render(key, input[key]).length };
};
