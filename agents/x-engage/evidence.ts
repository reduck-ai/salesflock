// x-engage's evidence renderer — the agent OWNS its rendering. Sole consumer today, so it lives
// here, not in src/ (a shared src/ util is YAGNI until a second X agent exists). One file, one
// decision, imported by BOTH consumers: the runtime judge (tools.ts) and the review app
// ($agent/evidence) — so they can never render differently. It is the X sibling of
// src/linkedin/{evidence,activity}.ts, folded into one: the generic seam (renderEvidence +
// fieldSpan, the pair the judge and app call) plus the x.com display knowledge (renderTweet /
// renderThread) that turns the lossless YAML the tools freeze into x.com-shaped Markdown. A
// Decision freezes the Input MAP, so improving these renderers reflows every X Decision on read —
// no re-judge. Values pass through verbatim (the focal post body is prefix-free) so a quote anchors.

import { parse } from "yaml";
import { markdown } from "../../src/markdown.js";
import type { Quote } from "../../src/anchor.js";

const dot = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(" · ");

// The focal post — an x.com card: the author header, the body PLAIN (so a judge's quote anchors on
// it), then a muted metrics line. Falls back to generic Markdown when the field isn't the YAML shape
// `scan` freezes (e.g. an older Decision that froze the bare body) — a malformed field never crashes.
interface Tweet {
	name?: string | null;
	handle?: string | null;
	time?: string | null;
	text?: string | null;
	reach?: number | null;
	replies?: number | null;
}
const renderTweet = (yaml: string): string => {
	let t: Tweet | null;
	try {
		t = parse(yaml);
	} catch {
		return markdown(yaml);
	}
	if (!t || typeof t !== "object" || typeof t.text !== "string") return markdown(yaml);
	const who = [t.name && `**${t.name}**`, t.handle && `@${t.handle}`].filter(Boolean).join(" ");
	const meta = dot(t.reach != null && `${t.reach} views`, t.replies != null && `${t.replies} replies`);
	return [dot(who, t.time), t.text, meta && `_${meta}_`].filter(Boolean).join("\n\n");
};

// The author's answered exchanges — the qualify signal, as x.com reply cards (the sibling of
// activity.ts' renderComment): the replier's comment boxed, the author's reply beneath. This is
// CONTEXT (why the author is worth replying to), so it is boxed — the reply we draft answers the
// POST, not these. Falls back to Markdown on the old prose shape or a malformed field.
interface Thread {
	author?: string | null;
	exchanges?: { replier?: string | null; text?: string | null; reply?: string | null }[];
}
const box = (...lines: (string | null | undefined)[]): string =>
	lines
		.filter((l): l is string => l != null)
		.flatMap((l) => l.split("\n"))
		.map((l) => `> ${l}`)
		.join("\n");
const renderThread = (yaml: string): string => {
	let d: Thread | null;
	try {
		d = parse(yaml);
	} catch {
		return markdown(yaml);
	}
	if (!d || typeof d !== "object" || !Array.isArray(d.exchanges)) return markdown(yaml);
	return d.exchanges
		.map((e) => `${box(`**@${e.replier ?? "?"}**`, e.text)}\n↳ **@${d!.author ?? "author"}:** ${e.reply ?? ""}`)
		.join("\n\n");
};

// Per-field renderer: the two rich fields mirror x.com; everything else is generic Markdown.
const renderers: Record<string, (v: string) => string> = { Post: renderTweet, "Author engagement": renderThread };
const render = (k: string, v: string): string => (renderers[k] ?? markdown)(v);

// The lossless input map → one Markdown document, a `### field` section each — verbatim values, so a
// quote resolves against it. The judge reads this as its prompt; the app renders the same from the
// frozen map. One renderer, every caller. (The X twin of src/linkedin/evidence.ts:renderEvidence.)
export const renderEvidence = (input: Record<string, string>): string =>
	Object.entries(input)
		.map(([k, v]) => `### ${k}\n\n${render(k, v)}`)
		.join("\n\n");

// fieldSpan(input, key) — the [start,end) of `key`'s rendered CONTENT within renderEvidence(input),
// derived from the very sections renderEvidence joins (same `render`, same `\n\n` join — they can't
// drift). How CODE, never the LLM, gives the composer its anchor: the span of the field the reply
// answers (the X "Post"). null when the field isn't present. (The X twin of linkedin's fieldSpan.)
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
