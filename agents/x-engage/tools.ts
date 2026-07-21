// x-engage tools — the clean flow, three stages that mirror the other agents:
//   scan  → discover (feed) + the deterministic signal → an X Engagement at "To draft"
//   draft → decide("reply") → ONE Decision (the shared judge+gate) → Engagement "Draft pending review"
//   post  → an Approved engagement's committed reply → reply_to_tweet → "Posted"
//
// The draft is a real Decision, so it flows through the same engine and review surface as every
// other agent — no bespoke drafter. This file is only agent wiring: the X entity bridge (the X
// Engagement row is both the subject that carries the evidence AND the pipeline entity), and the
// three stage tools. Monotonic + idempotent on Post URL, like the LinkedIn funnels.

import { getPersonalFeed, getTweet, reply as postReply } from "../../src/clients/x/index.js";
import { getStore } from "../../src/stores/index.js";
import { createDecider } from "../../src/decide.js";
import { renderEvidence } from "../../src/x/evidence.js";
import { projectInput } from "../../src/project.js";
import { mapLimit } from "../../src/concurrency.js";
import { answeredRepliers, renderSignal } from "./signal.js";
import config from "./config.js";
import type { Subject, EntityLink } from "../../src/decide.js";
import type { PromptSpec } from "../../src/stores/index.js";
import type { Feed } from "../../src/clients/x/schema.js";
import type { XEngagements } from "./schema/Engagements.js";

const store = getStore(config.destination);
type Post = Feed["tweets"][number];

// The X entity bridge (this agent's own wiring): the X Engagement row IS the subject — it carries
// the frozen post evidence (Post + Author engagement) projectInput reads — AND the pipeline entity
// the Decision binds to. resolveSubject reads it by Post URL; linkEntity advances it to the prompt's
// pending gate and returns the relation the Decision stamps.
const resolveSubject = async (postUrl: string): Promise<Subject> => {
	const row = await store.read(config.models.Engagements, "Post URL", postUrl);
	return { key: postUrl, name: String(row.fields.Name ?? postUrl), fields: row.fields, ref: row.id };
};
const linkEntity = async (
	subject: Subject,
	spec: PromptSpec,
	{ dependsOn }: { dependsOn?: string[] }
): Promise<EntityLink> => {
	if (!dependsOn?.length)
		await store.upsert(
			config.models.Engagements,
			{ Name: subject.name, "Post URL": subject.key, Status: spec.pending },
			"Post URL"
		);
	return { relation: "X Engagement", id: subject.ref as string };
};

const decider = createDecider({ config, store, renderEvidence, projectInput, resolveSubject, linkEntity });

// Statuses at or past the draft gate — scan must never drag such an engagement back to "To draft".
const ADVANCED = new Set(["Draft pending review", "Approved", "Posted", "Skipped"]);

const statusOf = async (postUrl: string): Promise<string | null> => {
	const [e] = await store.query(config.models.Engagements, { property: "Post URL", url: { equals: postUrl } });
	return e ? String(e.fields.Status ?? "") : null;
};

// The committed reply of an engagement's Decision — the human's Final output if reviewed, else the
// drafted Output. Both are the {reply} object the Output schema gates.
const committedReply = (row: { fields: Record<string, unknown> }): string =>
	(JSON.parse(String(row.fields["Final output"] ?? row.fields.Output)) as { reply: string }).reply;

export const tools = {
	// scan — For You feed → keep posts whose author answered a replier → write/refresh an X Engagement
	// at "To draft" (monotonic: never drags an already-advanced engagement back). Drafting is a
	// separate stage, so scan writes no Decision and calls no LLM.
	scan: async (count = 20, replyDepth = 60) => {
		const feed = await getPersonalFeed(count);
		const candidates = feed.tweets.filter((t: Post) => !t.is_retweet && t.reply_count > 0);
		const ranAt = new Date().toISOString();
		return mapLimit(candidates, async (t: Post) => {
			const { replies } = await getTweet(t.url, replyDepth);
			const answered = answeredRepliers(t.author.handle, t.id, replies);
			if (!answered.length) return { url: t.url, author: t.author.handle, signal: false };
			const advanced = ADVANCED.has((await statusOf(t.url)) ?? "");
			const row: XEngagements = {
				Name: `@${t.author.handle} — ${t.text.slice(0, 60).replace(/\s+/g, " ").trim()}`,
				"Post URL": t.url,
				Author: t.author.handle,
				"Author name": t.author.name,
				Post: t.text,
				"Author engagement": renderSignal(t.author.handle, answered),
				Reach: t.view_count ?? undefined,
				"Scanned at": ranAt,
				...(advanced ? {} : { Status: "To draft" })
			};
			const r = await store.upsert(config.models.Engagements, row, "Post URL");
			return { url: t.url, author: t.author.handle, signal: true, answered: answered.length, engagement: r.url };
		});
	},

	// draft — judge one engagement against the "X Reply" contract; writes one Decision and moves the
	// engagement to the pending review gate. `context` prints the frozen judgment context, writes nothing.
	draft: (postUrl: string) => decider.decide("reply", postUrl),
	context: (postUrl: string) => decider.context("reply", postUrl),

	// draftPending — draft every engagement still at "To draft".
	draftPending: async () => {
		const rows = await store.query(config.models.Engagements, { property: "Status", select: { equals: "To draft" } });
		return mapLimit(rows, (r) => decider.decide("reply", String(r.fields["Post URL"])));
	},

	// post — the outward action: an Approved engagement's committed reply → reply_to_tweet → "Posted".
	// No-ops (reports) if the engagement is not Approved — the human gate is the only path to posting.
	post: async (postUrl: string) => {
		const eng = await store.read(config.models.Engagements, "Post URL", postUrl);
		if (eng.fields.Status !== "Approved") return { url: postUrl, skipped: true, status: eng.fields.Status ?? null };
		const decisions = await store.query(config.models.Decisions, {
			property: "X Engagement",
			relation: { contains: eng.id }
		});
		const decision = decisions.find((d) => d.fields["Final output"]) ?? decisions[0];
		if (!decision) throw new Error(`no Decision linked to ${postUrl}`);
		const text = committedReply(decision);
		const posted = await postReply(postUrl, text);
		await store.upsert(
			config.models.Engagements,
			{ Name: String(eng.fields.Name), "Post URL": postUrl, Status: "Posted" },
			"Post URL"
		);
		return { url: postUrl, posted: posted.url, reply: text };
	},

	// postApproved — post every Approved engagement.
	postApproved: async () => {
		const rows = await store.query(config.models.Engagements, { property: "Status", select: { equals: "Approved" } });
		return mapLimit(rows, (r) => tools.post(String(r.fields["Post URL"])));
	},

	// list / show — the review queue and one Decision, straight off the shared engine.
	list: () => decider.list(),
	show: (handle: string) => decider.showDecision(handle)
};
