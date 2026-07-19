// The app's one markdown→HTML renderer. marked (CommonMark + GFM soft breaks) renders the
// natural nested evidence — nested lists, bold labels, `**key:** value` continuation lines,
// paragraphs — that a minimal renderer can't. Autolinking is disabled on purpose: bare URLs
// are owned by Markdown.svelte's `linkify`, which runs after the highlight sentinels are
// swapped for <mark> tags, so a URL abutting a sentinel can't corrupt either. One instance,
// shared by both render paths (plain and highlighted), so they can never drift.

import { Marked } from "marked";

const marked = new Marked({ gfm: true, breaks: true, async: false }).use({
	tokenizer: { url: () => undefined, autolink: () => undefined }
});

export const renderMd = (src: string): string => marked.parse(src) as string;
