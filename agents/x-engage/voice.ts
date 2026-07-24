// The owner's voice — the calibration corpus that grounds the drafter, plugged into the engine via
// createDecider's `renderExamples` seam (replacing the default prior-Decisions few-shot for this
// agent). It reads the owner's OWN posts (X Posts) and replies (X Replies) — how they actually
// write — and renders them as the judge's examples, so a drafted reply matches their real voice
// rather than a generic tone. Voice is subject-independent, so the (key, subject) args are ignored.
//
// A capped, possibly-paged sample is intentional here: examples only need to be representative, not
// exhaustive (unlike an elimination, which may never rest on a truncated read).

import { getStore } from "../../src/stores/index.js";
import config, { OWNER } from "./config.js";

const store = getStore(config.destination);
const SAMPLE = 15;

// The archive now records everyone we see, so voice must keep to the owner's OWN rows — otherwise a
// draft would learn the target author's voice instead of ours. Author == OWNER is that filter; a
// capped first page still stands in as the representative sample.
const mine = { property: "Author", rich_text: { equals: OWNER } };

export const voiceExamples = async (): Promise<string> => {
	const [posts, replies] = await Promise.all([
		store.query(config.models.XPosts, mine),
		store.query(config.models.XReplies, mine)
	]);
	const postBlock = posts
		.slice(0, SAMPLE)
		.map((p) => `- "${p.fields.Text}"`)
		.join("\n");
	const replyBlock = replies
		.slice(0, SAMPLE)
		.map((r) => {
			const parent = r.fields["Parent post"]
				? String(r.fields["Parent post"])
				: r.fields["Parent author"]
					? `(replying to @${r.fields["Parent author"]})`
					: "(reply)";
			return `> ${parent}\n↳ you: "${r.fields.Reply}"`;
		})
		.join("\n\n");
	const sections = [
		postBlock && `### Your posts\n\n${postBlock}`,
		replyBlock && `### Your replies\n\n${replyBlock}`
	].filter(Boolean);
	if (!sections.length) return "";
	return (
		"## Your voice\n\n" +
		"Below are your OWN recent posts and replies on X. Match this voice — diction, length, " +
		"punctuation, tone — when drafting the reply. Do not imitate the target author; sound like yourself.\n\n" +
		sections.join("\n\n")
	);
};
