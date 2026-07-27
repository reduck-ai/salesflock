// lk-engage's evidence renderer — the agent OWNS its rendering (one file, imported by BOTH
// consumers: the runtime judge in tools.ts and the review app via $agent/evidence, so they can
// never render differently). The LinkedIn sibling of x-engage/evidence.ts: the generic seam
// (renderEvidence + fieldSpan) plus the one display decision — the frozen Post YAML rendered as a
// LinkedIn-style card in the idiom of src/linkedin/activity.ts (author header line, body verbatim
// and prefix-free so a judge's quote anchors on it, a muted metrics line). A Decision freezes the
// Input MAP, so improving this renderer reflows every Decision on read — no re-judge.

import { parse } from "yaml";
import { markdown } from "../../src/markdown.js";
import type { Quote } from "../../src/anchor.js";

const dot = (...parts: (string | number | false | null | undefined)[]): string =>
	parts.filter((x) => x || x === 0).join(" · ");

// The frozen Post YAML `queue` writes: the focal LinkedIn post.
interface Post {
	name?: string | null;
	publicId?: string | null;
	headline?: string | null;
	age?: string | null;
	text?: string | null;
	reactions?: number | null;
	comments?: number | null;
	reposts?: number | null;
}

// The focal post as a LinkedIn card: `**Name** · headline · age`, the body PLAIN (quotes anchor on
// it), then metrics. Falls back to generic Markdown when the field isn't the YAML shape `scan`
// freezes.
const renderPost = (yaml: string): string => {
	let p: Post | null;
	try {
		p = parse(yaml);
	} catch {
		return markdown(yaml);
	}
	if (!p || typeof p !== "object" || typeof p.text !== "string") return markdown(yaml);
	const header = dot(`**${p.name ?? p.publicId ?? "Unknown"}**`, p.headline, p.age);
	const metrics = dot(
		p.reactions != null && `${p.reactions} reactions`,
		p.comments != null && `${p.comments} comments`,
		p.reposts != null && `${p.reposts} reposts`
	);
	return [header, p.text, metrics && `*${metrics}*`].filter(Boolean).join("\n\n");
};

// Per-field renderer: Post mirrors LinkedIn; everything else is generic Markdown.
const renderers: Record<string, (v: string) => string> = { Post: renderPost };
const render = (k: string, v: string): string => (renderers[k] ?? markdown)(v);

// The lossless input map → one Markdown document, a `### field` section each — verbatim values, so
// a quote resolves against it. The judge reads this as its prompt; the app renders the same from
// the frozen map. One renderer, every caller. (The Lk twin of x-engage's renderEvidence.)
export const renderEvidence = (input: Record<string, string>): string =>
	Object.entries(input)
		.map(([k, v]) => `### ${k}\n\n${render(k, v)}`)
		.join("\n\n");

// fieldSpan(input, key) — the [start,end) of `key`'s rendered CONTENT within renderEvidence(input),
// derived from the very sections renderEvidence joins (same `render`, same `\n\n` join — they can't
// drift). How CODE, never the LLM, gives the composer its anchor: the span of the field the comment
// answers (the "Post"). null when the field isn't present.
export const fieldSpan = (input: Record<string, string>, key: string): Quote | null => {
	const entries = Object.entries(input);
	const i = entries.findIndex(([k]) => k === key);
	if (i < 0) return null;
	const pre = entries
		.slice(0, i)
		.map(([k, v]) => `### ${k}\n\n${render(k, v)}`)
		.join("\n\n");
	const start = (i ? pre.length + 2 : 0) + `### ${key}\n\n`.length;
	return { start, end: start + render(key, input[key]).length };
};
