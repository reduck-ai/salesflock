#!/usr/bin/env node
// ONE-TIME migration: the day an outreach stopped being a THREAD and became a PERSON.
//
//   node agents/reddit-engage/migrate.mjs [--apply]      (run from salesflock/, after `npm run build`)
//   — without --apply it prints what it WOULD do and writes nothing.
//
// Delete this file once it has run. It exists because the re-key cannot be inferred from the data:
// every Backlog row was keyed on the thread it answered, so a human who posted twice has TWO rows,
// and nothing in the store says they are one conversation. `userUrl(thread.Author)` says it, and
// performing that join is the whole job.
//
// Three steps, and only the second is destructive:
//   1. PERSON   — stamp each outreach with its author's canonical account URL (the new key). By ID,
//                 not by upsert: the row has no Person yet, so keying on it would create a twin.
//   2. MERGE    — collapse the rows that turn out to be one human: the loser's Decisions are
//                 re-pointed at the winner, its thread is attached to the winner, the row is
//                 archived (Notion's trash, recoverable).
//   3. ATTACH   — every qualified thread of a person we already track joins their outreach, so it
//                 leaves the owed set instead of becoming a second reply to the same human. This is
//                 the backfill of exactly what the runtime now does at its draft step.
//
// Idempotent: step 1 rewrites the same value, step 2 finds no collision the second time, step 3
// selects on `Backlog is_empty` and so sees nothing it already did. A second run is a no-op.

import "../../dist/src/env.js";
import { getStore, queryAll } from "../../dist/src/stores/index.js";
import { threadUrl, userUrl } from "../../dist/src/clients/reddit/index.js";
import config from "../../dist/agents/reddit-engage/config.js";

const apply = process.argv.includes("--apply");
const store = getStore(config.destination);
const { RedditThreads: THREADS, RedditBacklog: BACKLOG } = config.models;
const DECISIONS = config.models.Decisions;
const say = (...a) => console.error(...a);

const QUALIFIED = {
	or: [
		{ property: "Tier", select: { equals: "T1" } },
		{ property: "Tier", select: { equals: "T2" } }
	]
};

// ── the picture, read once ─────────────────────────────────────────────────────────────────────
const outreaches = await queryAll(store, BACKLOG, { property: "Thread URL", url: { is_not_empty: true } });
const qualified = await queryAll(store, THREADS, {
	and: [{ property: "Thread URL", url: { is_not_empty: true } }, QUALIFIED]
});
say(`${outreaches.length} outreaches, ${qualified.length} qualified threads`);

// thread URL → its row. Canonicalized on both sides so a stored spelling cannot miss (they are all
// canonical today — checked — but the lookup should not depend on that staying true).
const byUrl = new Map(qualified.map((t) => [threadUrl(String(t.fields["Thread URL"])), t]));
const authorOf = async (url) => {
	// An outreach on a thread that is not T1/T2 (a manual draft, an older rule) is not in the map —
	// read it directly rather than skip it: EVERY existing outreach must get a Person, or the new key
	// cannot reach it again.
	const row = byUrl.get(threadUrl(url)) ?? (await store.read(THREADS, "Thread URL", threadUrl(url)));
	if (!row.fields.Author) throw new Error(`thread ${url} has no Author — cannot key its outreach`);
	return String(row.fields.Author);
};

// ── who is who: person → the outreaches that turn out to be theirs ─────────────────────────────
const people = new Map();
for (const o of outreaches) {
	const person = userUrl(await authorOf(String(o.fields["Thread URL"])));
	if (!people.has(person)) people.set(person, []);
	people.get(person).push(o);
}

// WHO SURVIVES a merge, and it is not arbitrary: the conversation that actually happened. A row
// carrying a Comment URL points at a comment live on Reddit right now, and archiving it would orphan
// the only record of a deed we cannot undo — so a posted row always beats an unposted one, and
// between two posted rows the EARLIER wins (it is the one the other duplicated). The final
// tie-break is the page id: arbitrary, but TOTAL, so a re-run crowns the same winner.
const winnerOf = (rows) =>
	[...rows].sort(
		(a, b) =>
			(a.fields["Comment URL"] ? 0 : 1) - (b.fields["Comment URL"] ? 0 : 1) ||
			String(a.fields["Posted at"] ?? "￿").localeCompare(String(b.fields["Posted at"] ?? "￿")) ||
			a.id.localeCompare(b.id)
	)[0];

// ── steps 1 + 2 ────────────────────────────────────────────────────────────────────────────────
const keep = new Map(); // person → the surviving outreach id
let merged = 0;
for (const [person, rows] of [...people].sort(([a], [b]) => a.localeCompare(b))) {
	const winner = winnerOf(rows);
	keep.set(person, winner.id);
	const losers = rows.filter((r) => r.id !== winner.id);
	say(
		`${apply ? "PERSON" : "would "} ${person.padEnd(46)} ${String(winner.fields["Thread URL"])}` +
			(losers.length ? `   (+${losers.length} to merge)` : "")
	);
	// By ID. `upsert` would look for a row whose Person already equals this — there is none yet — and
	// dutifully create a second one. `patch` is the write for a row whose identity is not (yet) a column.
	if (apply) await store.patch(BACKLOG, winner.id, { Person: person });

	for (const loser of losers) {
		// The loser's Decisions must follow the row, or confirming one would move a page in the trash —
		// and `reply.act`, which reads the ENTITY's Comment URL to know whether it already spoke, would
		// be reading the wrong conversation and could post a second time. A relation is filterable even
		// though it is not readable off a Row, which is the only way to ask this at all.
		const decisions = await store.query(DECISIONS, {
			property: config.entity,
			relation: { contains: loser.id }
		});
		merged++;
		say(`         MERGE ${String(loser.fields["Thread URL"])}  ${decisions.length} decision(s) → winner, thread attached, row archived`);
		if (!apply) continue;
		for (const d of decisions) await store.patch(DECISIONS, d.id, { [config.entity]: [winner.id] });
		// From the THREAD side, exactly as the runtime attaches: the relation is synced (dual_property),
		// so this grows the winner's list without writing one column of their row.
		await store.upsert(
			THREADS,
			{ "Thread URL": threadUrl(String(loser.fields["Thread URL"])), Backlog: [winner.id] },
			"Thread URL"
		);
		await store.archive(loser.id);
	}
}

// ── step 3: every unattached qualified thread of a tracked person joins their outreach ─────────
// Selected on the relation being EMPTY, because that is the funnel's own definition of "owed" and
// because a Row comes back with its relations flattened away — "is it already attached?" is a
// question only the filter can answer, never the row.
say("");
const unattached = await queryAll(store, THREADS, {
	and: [
		{ property: "Thread URL", url: { is_not_empty: true } },
		QUALIFIED,
		{ property: "Backlog", relation: { is_empty: true } }
	]
});
let attached = 0;
for (const t of unattached) {
	const author = String(t.fields.Author ?? "");
	if (!author) continue;
	const outreach = keep.get(userUrl(author));
	if (!outreach) continue; // nobody is talking to them yet — the funnel may still draft this one
	const url = threadUrl(String(t.fields["Thread URL"]));
	attached++;
	say(`${apply ? "ATTACH" : "would "} ${url}  u/${author}  ${String(t.fields.Tier)}`);
	if (apply) await store.upsert(THREADS, { "Thread URL": url, Backlog: [outreach] }, "Thread URL");
}

say(
	`\n${people.size} people, ${merged} row(s) merged away, ${attached} thread(s) attached ` +
		`(of ${unattached.length} unattached qualified)`
);
say(apply ? "done" : "\ndry run — re-run with --apply");
