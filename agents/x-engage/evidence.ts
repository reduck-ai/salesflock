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

// The focal post — an x.com card in HTML (the app owns a real tweet component, not styled markdown):
// the author header, the body PLAIN (so a judge's quote anchors on it — canonicalize strips the tags,
// keeping the text), a muted metrics line, and the two context slots x.com itself shows — the answered
// tweet ABOVE (a reply) and the quoted tweet embedded BELOW. Each is 1:1 with reality: `draft` fetches
// the counterpart's real body (get_tweet) before judging. Falls back to generic Markdown when the field
// isn't the YAML shape `scan` freezes (e.g. an older Decision that froze the bare body).
interface Ref {
	name?: string | null;
	handle?: string | null;
	time?: string | null;
	text?: string | null;
	reach?: number | null;
	replies?: number | null;
}
interface Tweet extends Ref {
	parent?: Ref | null; // the tweet this one replies to (shown above, as x.com does)
	quoted?: Ref | null; // the tweet this one quotes (embedded below the body)
}

const head = (t: Ref): string => {
	const who = [t.name && `<b>${t.name}</b>`, t.handle && `@${t.handle}`].filter(Boolean).join(" ");
	return `<span class="tw-head">${dot(who, t.time)}</span>`;
};
const metrics = (t: Ref): string => {
	const m = dot(t.reach != null && `${t.reach} views`, t.replies != null && `${t.replies} replies`);
	return m ? `<span class="tw-meta">${m}</span>` : "";
};
// An embedded tweet — the answered parent or the quoted post: a bordered card, its body verbatim so a
// quote still anchors inside it. Rendered only once its real body is known (draft's get_tweet fetch).
const embed = (t: Ref, cls: string): string =>
	`<span class="tw-embed ${cls}">\n${[head(t), `<span class="tw-body">${t.text ?? ""}</span>`, metrics(t)].filter(Boolean).join("\n")}\n</span>`;

const renderTweet = (yaml: string): string => {
	let t: Tweet | null;
	try {
		t = parse(yaml);
	} catch {
		return markdown(yaml);
	}
	if (!t || typeof t !== "object" || typeof t.text !== "string") return markdown(yaml);
	// The FOCAL tweet — the one our reply answers — is the anchored "document": its own parts
	// (header, the "Replying to" line, body, any quoted embed, metrics) are wrapped in `tw-focal`
	// so the app can accent it as the reply's attachment point. The parent (the tweet it answers)
	// stays ABOVE the wrapper — the ancestor context, not the focal tweet (x.com order).
	const parent = t.parent?.text ? embed(t.parent, "tw-parent") : "";
	const focal = [
		head(t),
		t.parent?.handle && `<span class="tw-ctx">Replying to @${t.parent.handle}</span>`,
		`<span class="tw-body">${t.text}</span>`,
		(t.quoted?.text || t.quoted?.handle) && embed(t.quoted!, "tw-quote"),
		metrics(t)
	]
		.filter(Boolean)
		.join("\n");
	// A <pre> wrapper: it is the one HTML block kind `marked` passes through verbatim across blank
	// lines (tweet bodies have them) — an <article>/<div> block would be cut at the first blank line.
	// The tweet CSS resets <pre>'s monospace/whitespace; the body re-enables line wrapping. Single-`\n`
	// joins only (no blank line), so the app's block-split for the composer dock is unaffected.
	const parts = [parent, `<span class="tw-focal">\n${focal}\n</span>`].filter(Boolean);
	return `<pre class="tw">\n${parts.join("\n")}\n</pre>`;
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
