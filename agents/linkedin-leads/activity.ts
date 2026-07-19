// The one business-specific evidence renderer. LinkedIn activity — the lossless YAML `enrich`
// stores — mirrored as closely as Markdown allows to LinkedIn's own UI, so the judge and the
// review app read it the way the profile owner would. LinkedIn's whole feed is one recursive
// atom: an author-attributed card (`Name · headline · time`, then body), nested by embedding a
// card inside a card. The map is exact: the person's own words render plain (unquoted = theirs);
// anyone else's content is a blockquoted `card` with that author's header — a reshared post, or
// the post a comment sits under. All LinkedIn display knowledge lives here; a new source gets its
// own sibling. Noise (urns, permalinks) is dropped; values pass through verbatim so quotes anchor
// (a card's body carries a `> ` per line — the judge sees and copies it; the person's own words,
// the ones that matter, stay prefix-free).

import { parse } from "yaml";
import { markdown } from "../../src/markdown.js";

interface Post {
	text?: string | null;
	author?: string | null; // on a reshare, the ORIGINAL author; else the person
	headline?: string | null; // that author's headline/subtitle
	postedAgo?: string | null;
	reactions?: string | null;
	repostedBy?: string | null; // set when the person reshared someone else's post
	isQuoteReshare?: boolean;
}
interface Comment {
	text?: string | null; // the person's reply
	postedAgo?: string | null;
	post?: { author?: string | null; authorHeadline?: string | null; postedAgo?: string | null; text?: string | null } | null;
}

const dot = (...parts: (string | null | undefined | false)[]): string => parts.filter(Boolean).join(" · ");
const reacts = (n?: string | null) => n && `${n} reactions`;

// A blockquoted card — the 1:1 of LinkedIn's embedded post box: an author header, then the body.
const card = (name?: string | null, headline?: string | null, when?: string | null, text?: string | null): string =>
	[dot(`**${name ?? "Unknown"}**`, headline, when), ...(text ?? "(no text)").split("\n")]
		.map((l) => `> ${l}`)
		.join("\n");

// The person's own post: plain when authored; a boxed card when reshared (author/headline are
// then the ORIGINAL author's). A quote-reshare's own commentary is all the scrape gives, so it
// reads as an authored post, flagged.
const renderPost = (p: Post): string =>
	p.repostedBy
		? `**${dot("Reshared", p.postedAgo, reacts(p.reactions))}**\n${card(p.author, p.headline, null, p.text)}`
		: `**${dot(p.isQuoteReshare ? "Posted (reshare + commentary)" : "Posted", p.postedAgo, reacts(p.reactions))}**\n${p.text ?? "(no text)"}`;

// A comment: the post they replied to as a boxed card, their reply attached beneath it.
const renderComment = (c: Comment): string =>
	`${card(c.post?.author, c.post?.authorHeadline, c.post?.postedAgo, c.post?.text)}\n↳ **replied**${c.postedAgo ? ` · ${c.postedAgo}` : ""}: ${c.text ?? "(no text)"}`;

const section = (title: string, items?: string[]): string =>
	items?.length ? `**${title}**\n\n${items.join("\n\n")}` : "";

// renderActivity(activityYaml) — the two lenses, each mirroring LinkedIn. Falls back to the
// generic renderer if the field is not the shape we own (a malformed field must not crash the
// judgment context).
export const renderActivity = (activityYaml: string): string => {
	let data: { posts?: Post[]; comments?: Comment[] } | null;
	try {
		data = parse(activityYaml);
	} catch {
		return markdown(activityYaml);
	}
	const out = [
		section("Posts", data?.posts?.map(renderPost)),
		section("Comments (replies on others' posts)", data?.comments?.map(renderComment))
	]
		.filter(Boolean)
		.join("\n\n");
	return out || markdown(activityYaml);
};
