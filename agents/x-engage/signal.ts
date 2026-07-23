// The engagement signal — deterministic, pure over get_replies output. Did the post's author
// ANSWER at least one of their repliers (not merely continue their own thread)? An OP reply whose
// `in_reply_to` points at ANOTHER person's reply is the proof: this author engages the crowd, so a
// good reply from us is likely to earn a response — the whole thesis of the funnel. A self-thread
// reply (in_reply_to === the root) is explicitly NOT the signal. Returns the answered exchanges as
// evidence (validated live on jacob_posel: he answered CostaLaveron / ecomjeg / sebastian_dtc).

import type { Tweet } from "../../src/clients/x/schema.js";

type Reply = Tweet["replies"][number];
export interface Answered {
	to: Reply; // the replier's reply the author responded to
	opReply: Reply; // the author's response
}

export const answeredRepliers = (author: string, rootId: string, replies: Reply[]): Answered[] => {
	const byId = new Map(replies.map((r) => [r.id, r]));
	return replies
		.filter((r) => r.author === author && r.in_reply_to && r.in_reply_to !== rootId)
		.map((r) => ({ opReply: r, to: byId.get(r.in_reply_to as string) }))
		.filter((x): x is Answered => !!x.to && x.to.author !== author);
};

// A compact proof block for the Signal column and the drafter's context — how the author rewards
// replies, in their own words, so the draft can match the tone that actually earns a response.
export const renderSignal = (author: string, answered: Answered[]): string =>
	`@${author} answered ${answered.length} replier(s):\n` +
	answered
		.map((a) => `• @${a.to.author}: "${a.to.text}"\n  → @${author}: "${a.opReply.text}"`)
		.join("\n");

// The deterministic qualify gate — the X sibling of former-rpa-pms' vendors.ts `classify`. Three
// outcomes, never two (eliminate on evidence, never on absence): the author answered ≥1 commenter
// (pass — worth a reply), replies exist but the author answered none of them (a data-backed miss,
// eliminate), or no replies came back at all (insufficient data — defer, so a re-run can retry).
export interface Qualification {
	answered: Answered[];
	pass: boolean; // ≥1 answered replier — advance to "To engage"
	eliminate: boolean; // replies present, none answered — terminal "Not qualified"
}

export const classify = (author: string, rootId: string, replies: Reply[]): Qualification => {
	const answered = answeredRepliers(author, rootId, replies);
	return { answered, pass: answered.length > 0, eliminate: replies.length > 0 && answered.length === 0 };
};

// disposition(q, author) — the one-line reason the gate reached its verdict, for the Backlog's
// comment trail. Only the terminal miss is commented; a defer says nothing (a retry would duplicate it).
export const disposition = (q: Qualification, author: string): string =>
	q.eliminate
		? `Not qualified — @${author} did not answer any replier on this post`
		: `Deferred — no replies returned for this post; retry qualify`;
