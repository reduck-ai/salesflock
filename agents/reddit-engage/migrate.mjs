#!/usr/bin/env node
// ONE-TIME migration: the day pipeline state left Reddit Threads for its own table.
//
//   node agents/reddit-engage/migrate.mjs [--apply]      (run from salesflock/, after `npm run build`)
//   — without --apply it prints what it WOULD do and writes nothing.
//
// Delete this file once it has run. It exists because the split cannot be inferred from the data
// alone: every Decision made before it binds to a Reddit Thread, and the review app now looks for a
// Reddit Backlog — so confirming an old draft would write its output and move nothing, loudly but
// too late. This gives each existing Decision the outreach row it should always have had.
//
// The threads themselves need NO migration, which is the point of where the line was drawn: the
// Tier already says everything the funnel reads (empty ⇒ judge it, T1/T2 ⇒ draft it, "No" ⇒ done),
// so the retired Status column is not translated, it is simply abandoned — and the rows that used
// to sit at a status off the ladder, which a re-scan kept dragging backward, stop being anomalous
// by construction rather than by repair.
//
// Idempotent: the Backlog upserts on the canonical Thread URL and the Decision's relation is set to
// exactly one row, so a second run converges on the same state.

import "../../dist/src/env.js";
import { getStore, queryAll } from "../../dist/src/stores/index.js";
import { threadUrl } from "../../dist/src/clients/reddit/index.js";
import config from "../../dist/agents/reddit-engage/config.js";

const apply = process.argv.includes("--apply");
const store = getStore(config.destination);
const REPLY = config.prompts.reply.name;

// Walk from the THREADS, not the Decisions — a store Row comes back with its relations flattened
// away, so a Decision cannot say which thread it belongs to, while the thread's own `Decision`
// relation is a filterable fact. Every thread that ever produced a Decision is exactly the set that
// needs an outreach row.
const threads = await queryAll(store, config.models.RedditThreads, {
	property: "Decision",
	relation: { is_not_empty: true }
});
console.error(`${threads.length} threads carry a Decision`);

for (const thread of threads) {
	const url = threadUrl(String(thread.fields["Thread URL"]));
	// This thread's decisions, found the same way round: the relation is filterable even though it is
	// not readable off a row.
	const decisions = await store.query(config.models.Decisions, {
		property: "Reddit Thread",
		relation: { contains: thread.id }
	});
	const replies = decisions.filter((d) => String(d.fields.Name ?? "").includes(REPLY));
	if (!replies.length) {
		console.error(`SKIP  ${url} — decisions, but none of kind "${REPLY}"`);
		continue;
	}
	// Committed or not, the outreach is at "Pending approval": the reply was never posted (nothing
	// could post it until now), so confirming it in the app is exactly what is still owed — and for
	// the already-committed ones that is a re-confirm, which is precisely what `act`'s guard on
	// `Comment URL` was written to make safe.
	console.error(`${apply ? "LINK " : "would"} ${url}  (${replies.length} reply decision(s))`);
	if (!apply) continue;
	const ref = await store.upsert(
		config.models.RedditBacklog,
		{
			Name: String(thread.fields.Name ?? url),
			"Thread URL": url,
			Thread: [thread.id],
			Status: config.prompts.reply.pending
		},
		"Thread URL"
	);
	for (const d of replies)
		await store.upsert(
			config.models.Decisions,
			{ Name: String(d.fields.Name), "Reddit Backlog": [ref.id] },
			"Name"
		);
}

// STEP 2 — un-decide the replies that were confirmed before anything could post them.
//
// They were committed under the old funnel, where confirming meant "approved" and a later pass was
// supposed to send. That pass never existed, so the comments were never posted — and a committed row
// is out of the review queue, which is now the only place a post can happen. So they go back.
//
// `Final output` is the sole marker of a review, so clearing it IS the un-decide (src/decide.ts,
// app/…/notion.ts and review.ts all read exactly that one property). The human's text is not lost
// with it: it moves to `Draft output`, the working-copy channel, so the card reopens on THEIR words
// rather than the model's — which is the whole reason that column now exists. `Feedback` and `Final
// reasoning` are cleared: the ask was to remove the trace of the review, and the note's content is
// preserved anyway wherever it mattered (an overturn re-derives itself the moment they confirm
// again, since `Final output ≢ Output` is computed, never stored).
const decided = await queryAll(store, config.models.Decisions, {
	and: [
		{ property: "Final output", rich_text: { is_not_empty: true } },
		{ property: "Draft output", rich_text: { is_empty: true } }
	]
});
const stale = decided.filter((d) => String(d.fields.Name ?? "").includes(REPLY));
console.error(`\n${stale.length} committed "${REPLY}" decision(s) to reopen`);
for (const d of stale) {
	const name = String(d.fields.Name);
	const human = String(d.fields["Final output"]);
	// Only carry the text forward when it is actually theirs. A confirm-verbatim row has nothing to
	// restore — its committed output IS the judge's — and writing a draft equal to `Output` would
	// invent a human edit that never happened.
	const edited = human !== String(d.fields.Output ?? "");
	console.error(`${apply ? "REOPEN" : "would"} ${name}${edited ? "  (restoring the human's text)" : ""}`);
	if (!apply) continue;
	await store.upsert(
		config.models.Decisions,
		{
			Name: name,
			"Final output": "",
			Feedback: "",
			"Final reasoning": "",
			...(edited ? { "Draft output": human } : {})
		},
		"Name"
	);
}
console.error(apply ? "done" : "\ndry run — re-run with --apply");
