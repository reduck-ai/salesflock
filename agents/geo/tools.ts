// geo tools — the funnel. Three stages joined by the store, and what marks a row's place is DATA a
// previous stage HAD to write, never a status anyone maintains:
//
//   ask     one assistant, one prompt, one draw → an Answer row (the answer, the sources it read),
//           plus a Query row per reformulation. Owed while the prompt has fewer than `--draws`
//           answers that measured something.
//   search  one query on its engine → a Result row per ranked page. Owed while `Searched at` is empty.
//   read    one result over plain HTTP → status, text length, mention count. Owed while `Fetched at`
//           is empty, OR while its `Brand` stamp is not today's.
//
// THE TABLES ARE JOINED BY NOTION RELATIONS, and each one is written from the side whose list is
// COMPLETE the moment it is written — the child. Notion syncs the dual, so the parent's list grows
// without a single column of the parent being touched:
//
//   Answer.Prompt   → one prompt          ⇒ Prompt.Answers fills itself
//   Answer.Queries  → that draw's whole reformulation set, known at write time
//   Result.Query    → one query           ⇒ Query.Results fills itself
//
// Never the other way round. A relation write REPLACES the list, so writing Prompt.Answers would
// clobber every sibling already attached — the same trap reddit-engage's `attach` exists to avoid.
// Written from the child, there is no list to clobber and nothing to read-before-write.
//
// EVERY VERDICT IS DERIVED, NOTHING IS CACHED. `Asks`, `Cited`, whether an answer read us, whether a
// page is readable, whether a URL is ours, the diagnosis itself — all computed here from raw columns
// and relations, every time. The one exception is `Mentions`, because the page body it counts is
// megabytes and we throw it away; it therefore carries the `Brand` stamp, which is what puts a
// re-count into the owed set the moment BRAND changes rather than leaving old numbers to rot.

import { getStore, queryAll } from "../../src/stores/index.js";
import type { Row } from "../../src/stores/index.js";
import { mapLimit, batch } from "../../src/concurrency.js";
import { drain } from "../../src/drain.js";
import { renderError } from "../../src/errors.js";
import { log } from "../../src/log.js";
import * as http from "../../src/clients/http.js";
import {
	ask as askAssistant,
	searchAll,
	canonicalUrl,
	hostIsOurs,
	promptKey,
	queryKey,
	queryParts,
	resultKey,
	resultParts
} from "../../src/clients/geo/index.js";
import config, { BRAND, brandStamp, DEFAULT_PROVIDER, ENGINES, PROVIDERS, engineOf } from "./config.js";
import type { GEOAnswers } from "./schema/GEOAnswers.js";
import type { GEOPrompts } from "./schema/GEOPrompts.js";
import type { GEOQueries } from "./schema/GEOQueries.js";
import type { GEOResults } from "./schema/GEOResults.js";

const store = getStore(config.destination);
const { GEOPrompts: PROMPTS, GEOAnswers: ANSWERS, GEOQueries: QUERIES, GEOResults: RESULTS } = config.models;

// ─── the writes: one per table, and the ONE place each identity key is minted ────────────────────
//
// The key is a positional argument and the field map's type forbids it, for the reason reddit-engage
// gives at the same seam: a caller that supplies its own key can mis-spell it, and Notion answers a
// non-canonical key by CREATING A SECOND PAGE — silent on the way in, permanent once made, and
// invisible to every filter here. Minting it here makes that unreachable rather than merely unlikely.

const writePrompt = (prompt: string, fields: Omit<Partial<GEOPrompts>, "Prompt"> = {}) =>
	store.upsert(PROMPTS, { ...fields, Prompt: promptKey(prompt) }, "Prompt");

// An answer is CREATED, never upserted: it accumulates. Three draws of one prompt are three rows,
// because the assistant answers differently each time and that variance IS the measurement. It also
// needs no identity column at all — nothing ever looks one up by key.
const writeAnswer = (fields: GEOAnswers) => store.create(ANSWERS, fields);

const writeQuery = (key: string, fields: Omit<Partial<GEOQueries>, "Key"> = {}) =>
	store.upsert(QUERIES, { ...fields, Key: key }, "Key");

const writeResult = (key: string, fields: Omit<Partial<GEOResults>, "Key">) =>
	store.upsert(RESULTS, { ...fields, Key: key }, "Key");

// ─── the derivations: everything the tables deliberately do not store ────────────────────────────

const lines = (v: unknown): string[] =>
	String(v ?? "")
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);

// Ours, tolerant of a malformed URL: a source list is whatever the assistant reported, so one
// unparseable entry must not take down a whole verdict.
const ours = (url: string): boolean => {
	try {
		return hostIsOurs(url, BRAND.domain);
	} catch {
		return false;
	}
};

// The four facts a diagnosis is made of. A struct rather than a Row, because the verdict is a pure
// function of a DRAW and the caller that has just made one holds these directly — it should not have
// to fake a store row to ask what it got.
export interface Draw {
	stopReason: string;
	queries: number;
	sources: string[];
	answer: string;
}

// The diagnosis for ONE draw. The order is the order of causes: a truncated answer is not a
// measurement at all, then "did it even search", then the three retrieval outcomes.
//
// `Truncated` is the invariant this repo states as "eliminate on evidence, never on absence": an
// answer cut off mid-stream may simply not have reached our name yet, so calling it `Not retrieved`
// would freeze a false negative. It is insufficient data, and it defers.
export type Verdict = "Truncated" | "No search" | "Not retrieved" | "Passed over" | "Cited";

export const verdictOf = (d: Draw): Verdict => {
	if (d.stopReason !== "end_turn") return "Truncated";
	if (!d.queries) return "No search";
	// Word-boundary matched against every declared alias, so a short brand name cannot fire inside an
	// unrelated word.
	if (http.count(d.answer, BRAND.aliases) > 0) return "Cited";
	// Did its tools READ one of our pages? The raw source list is kept precisely so this is derived
	// fresh under today's BRAND rather than frozen as a boolean under the brand of the day it ran.
	return d.sources.some(ours) ? "Passed over" : "Not retrieved";
};

// A stored answer → the draw it records. The `Queries` RELATION is what says whether it searched —
// which is the whole reason `Row.rel` had to exist: as a text column that fact was a second copy of
// the join, and without it the relation could be written and never read.
export const drawOf = (a: Row): Draw => ({
	stopReason: String(a.fields["Stop reason"] ?? ""),
	queries: (a.rel.Queries ?? []).length,
	sources: lines(a.fields.Sources),
	answer: String(a.fields.Answer ?? "")
});

// Best across draws — how a PROMPT stands, given that its answers disagree. `Truncated` is absent
// from the ladder on purpose: it is not an outcome, so it neither wins nor counts.
const BEST: readonly Verdict[] = ["Cited", "Passed over", "Not retrieved", "No search"];

// One prompt, as everything anyone reads about it — computed from its answers rather than stored
// beside them. Answers are matched by the RELATION, so nothing here depends on a copy of the prompt's
// text living on the child. `asks` excludes truncated draws, which is what makes `--draws 3` retry
// one instead of counting it.
export const promptView = (p: Row, answers: Row[]) => {
	const mine = answers.filter((a) => (a.rel.Prompt ?? []).includes(p.id));
	const verdicts = mine.map((a) => verdictOf(drawOf(a)));
	const measured: Verdict[] = verdicts.filter((v) => v !== "Truncated");
	const at = mine.map((a) => String(a.fields["Asked at"] ?? "")).filter(Boolean).sort();
	return {
		prompt: String(p.fields.Prompt ?? ""),
		asks: measured.length,
		cited: verdicts.filter((v) => v === "Cited").length,
		verdict: BEST.find((v) => measured.includes(v)) ?? null,
		truncated: verdicts.length - measured.length,
		lastAsked: at[at.length - 1] ?? null
	};
};

// A fetched result, as read: the two booleans the columns deliberately do not hold. `readable` needs
// BOTH halves and that is the whole reason `Status` and `Text length` are separate columns — a 403
// is bot protection (nothing you write helps) and a 200 with no text is a client-rendered shell
// (server-render it), and the two need opposite work.
const MIN_TEXT = Number(process.env.GEO_MIN_TEXT) || 500;
export const resultView = (r: Row) => {
	const url = String(r.fields.URL ?? "");
	const status = Number(r.fields.Status ?? 0);
	const len = Number(r.fields["Text length"] ?? 0);
	const fetched = !!r.fields["Fetched at"];
	return {
		url,
		// Read off this row's OWN key, not by following the relation into the queries table — the label
		// is already here, and a read to learn something the row already says is a read for nothing.
		// The relation is still the join; this is just how the row names itself.
		query: resultParts(String(r.fields.Key ?? " :: ")).query,
		rank: r.fields.Rank ?? null,
		title: r.fields.Title ?? null,
		snippet: r.fields.Snippet ?? null,
		age: r.fields.Age ?? null,
		ours: url ? ours(url) : false,
		fetchedAt: r.fields["Fetched at"] ?? null,
		status: fetched ? status : null,
		textLength: fetched ? len : null,
		// Unfetched ⇒ unknown, not false. The two negatives must not fuse: "we looked and it is a
		// shell" and "we never looked" are different facts, and only one of them is evidence.
		readable: fetched ? status >= 200 && status < 300 && len >= MIN_TEXT : null,
		mentions: fetched ? Number(r.fields.Mentions ?? 0) : null,
		stale: fetched && String(r.fields.Brand ?? "") !== brandStamp()
	};
};

// ─── selecting: one vocabulary per table, compiled to store clauses ──────────────────────────────

export interface PromptSelect {
	prompt?: string[];
	verdict?: string;
	limit?: number;
}
export interface AnswerSelect {
	prompt?: string[];
	provider?: string;
	verdict?: string;
	limit?: number;
}
export interface QuerySelect {
	query?: string[];
	engine?: string;
	limit?: number;
}
export interface ResultSelect {
	query?: string[];
	url?: string[];
	ours?: boolean;
	mentions?: boolean;
	unreadable?: boolean;
	limit?: number;
}

const anyOf = (clauses: object[]): object[] =>
	clauses.length ? [clauses.length === 1 ? clauses[0] : { or: clauses }] : [];

// "Every row of this table" — a title is either empty or not, an exhaustive pair. The same idiom
// src/docs.ts uses, and the way a match-everything filter is expressed against Notion.
const all = (title: string) => ({
	or: [
		{ property: title, title: { is_empty: true } },
		{ property: title, title: { is_not_empty: true } }
	]
});
const ALL_ANSWERS = { and: [all("Name")] };
const ALL_QUERIES = { and: [all("Key")] };

// `limit` is deliberately absent from every filter: it trims the ANSWER, never the work, so it is a
// property of a reading and not a fact about the set. A filter that honoured it would hide work.
const newest = <T>(rows: T[], key: (t: T) => string, limit?: number): T[] => {
	const sorted = [...rows].sort((a, b) => key(b).localeCompare(key(a)));
	return limit ? sorted.slice(0, limit) : sorted;
};

const promptFilter = (o: PromptSelect): object => ({
	and: [all("Prompt"), ...anyOf((o.prompt ?? []).map((p) => ({ property: "Prompt", title: { equals: promptKey(p) } })))]
});

// A query is named by its full key or by its text alone — `--query "site:reduck.ai"` should find it
// whichever engine ran it, so a bare text matches the text column. `--engine` is the key's prefix,
// which is the same trick and the reason the engine lives in the identity.
const normQuery = (q: string): string => {
	if (q.includes(":") && ENGINES[queryParts(q).engine as keyof typeof ENGINES]) return q.trim().toLowerCase();
	return queryKey(engineOf(DEFAULT_PROVIDER), q);
};
const queryFilter = (o: QuerySelect): object => ({
	and: [
		all("Key"),
		...anyOf((o.query ?? []).map((q) => ({ property: "Key", title: { equals: normQuery(q) } }))),
		...(o.engine ? [{ property: "Key", title: { starts_with: `${o.engine.toLowerCase()}:` } }] : [])
	]
});

// A result's query narrows on the KEY's prefix, not on the relation — because a relation filter
// needs the query's page id, which costs a read, while the prefix is already in this row's own
// identity. The relation is still the join (it is what `rel.Query` reads and what a human clicks);
// this is just the cheaper way to say "of this query" when you have the text and not the id.
const resultFilter = (o: ResultSelect): object => ({
	and: [
		all("Key"),
		...anyOf((o.query ?? []).map((q) => ({ property: "Key", title: { starts_with: `${normQuery(q)} :: ` } }))),
		...anyOf((o.url ?? []).map((u) => ({ property: "URL", url: { equals: canonicalUrl(u) } }))),
		// `--ours` is a store filter and needs no `Ours` column: the domain is in the URL, which is
		// exactly why the boolean was never worth storing.
		...(o.ours ? [{ property: "URL", url: { contains: BRAND.domain } }] : []),
		...(o.mentions ? [{ property: "Mentions", number: { greater_than: 0 } }] : [])
	]
});

// ─── what is owed ────────────────────────────────────────────────────────────────────────────────

const UNSEARCHED = { and: [all("Key"), { property: "Searched at", date: { is_empty: true } }] };

// A result owes a read when it has never been fetched, OR when what it counted is no longer what
// "us" means. The second clause is the `Brand` stamp paying for itself: adding an alias to BRAND puts
// every counted result back in this set automatically, with no migration and nothing to remember.
const unread = (): object => ({
	and: [
		all("Key"),
		{
			or: [
				{ property: "Fetched at", date: { is_empty: true } },
				{ property: "Brand", rich_text: { does_not_equal: brandStamp() } }
			]
		}
	]
});

// ─── the stages ──────────────────────────────────────────────────────────────────────────────────

// ask — one draw. The write order IS the relation order: the prompt and the queries must exist
// before the answer can point at them, and by the time it does its whole list is known. So there is
// never a partial relation to fix up later, and never a list to append to.
export const ask = async (prompt: string, provider: string = DEFAULT_PROVIDER) => {
	const p = promptKey(prompt);
	const spec = PROVIDERS[provider as keyof typeof PROVIDERS];
	if (!spec) throw new Error(`no provider "${provider}" — declare it in agents/geo/config.ts`);
	const engine = engineOf(provider);

	const askedAt = new Date().toISOString();
	const a = await askAssistant(p, spec.target);

	const queries = a.webSearchQueries ?? [];
	const sources = (a.sources ?? []).map((s) => s.url).filter(Boolean);

	// The prompt row exists already on the normal path (`prompts add`), but a draw is also the moment
	// we learn a prompt is real — so this converges rather than assuming, and hands back the id the
	// relation needs.
	const promptRef = await writePrompt(p);
	// Each reformulation becomes a Query row, unsearched. Upserted, so the same query drawn by two
	// answers is ONE row that both answers point at — and that shared row IS the convergence signal:
	// a query the assistant keeps returning to is worth winning, a one-off is noise.
	const queryRefs = await mapLimit(queries, (q) =>
		writeQuery(queryKey(engine, q), { Engine: engine as GEOQueries["Engine"], Query: q.trim().toLowerCase() })
	);

	const fields: GEOAnswers = {
		Name: `${p.slice(0, 60)} — ${provider} — ${askedAt.slice(0, 19).replace("T", " ")}`,
		Prompt: [promptRef.id],
		Queries: queryRefs.map((r) => r.id),
		Provider: provider as GEOAnswers["Provider"],
		Model: spec.model,
		"Asked at": askedAt,
		Conversation: a.conversationId,
		"Stop reason": a.stopReason ?? "",
		Answer: a.answer,
		// Sources stay RAW TEXT, and that is not an oversight: a source is a URL the assistant read,
		// not a row — the script returns one flat deduped list per answer with no query attribution, so
		// there is nothing honest to relate it to. Small enough to keep whole, so the "did it read us"
		// question is answered fresh under today's BRAND instead of frozen as a boolean.
		Sources: sources.join("\n")
	};
	const ref = await writeAnswer(fields);

	const verdict = verdictOf({ stopReason: a.stopReason ?? "", queries: queries.length, sources, answer: a.answer });
	log("ask", `${p.slice(0, 48)} @${provider} → ${verdict} (${queries.length} queries, ${sources.length} sources)`);
	return { prompt: p, provider, verdict, queries, sources: sources.length, answer: ref.url };
};

// search — one query on its engine, and its results point back at it.
//
// `operatorsApplied: false` is the one guard, and it is a RUNTIME guard rather than a column: Brave
// found too few documents matching the operator, dropped it, and answered a relaxed query over the
// whole web. Those hits are not evidence about the operator, so none are written — the query is
// recorded as searched with zero results, which is the honest state.
export const searchQueries = async (rows: Row[]) => {
	if (!rows.length) return [];
	const keys = rows.map((r) => String(r.fields.Key));
	const outcomes = await searchAll(keys.map((k) => queryParts(k).query), ENGINES.brave.target);
	return mapLimit(rows, async (row, i) => {
		const key = keys[i];
		const outcome = outcomes[i];
		if (outcome.status === "rejected") return { query: key, error: renderError(outcome.reason) };
		const s = outcome.value;
		const relaxed = !s.operatorsApplied;
		const hits = relaxed ? [] : s.results;
		await mapLimit(hits, (r, rank) =>
			writeResult(resultKey(key, r.url), {
				Query: [row.id], // written from the child; Query.Results fills itself
				URL: canonicalUrl(r.url),
				Rank: rank + 1,
				Title: r.title,
				Snippet: r.snippet ?? undefined,
				Age: r.age ?? undefined
			}).catch(() => undefined)
		);
		await writeQuery(key, { "Searched at": new Date().toISOString() });
		log("search", `${key} → ${hits.length} results${relaxed ? " (operators dropped — relaxed query, not recorded)" : ""}`);
		return { query: key, results: hits.length, ...(relaxed ? { relaxed: true } : {}) };
	});
};

// read — one page over plain HTTP: can a crawler read it, and does it name us. No browser, because a
// crawler has none either: a page that only renders in one is a page a crawler cannot read, and that
// IS the finding.
export const readResult = async (row: Row) => {
	const url = String(row.fields.URL ?? "");
	if (!url) throw new Error(`result ${row.id} has no URL`);
	const got = await http.get(url);
	const mentions = http.count(got.text, BRAND.aliases);
	await store.patch(RESULTS, row.id, {
		"Fetched at": new Date().toISOString(),
		Status: got.status,
		"Text length": got.text.length,
		Mentions: mentions,
		// The stamp travels with the count it qualifies, in the same write — so there is no instant at
		// which a count exists without the definition it was made under.
		Brand: brandStamp()
	});
	return { url, status: got.status, textLength: got.text.length, mentions, ...(got.error ? { error: got.error } : {}) };
};

// ─── the tools ───────────────────────────────────────────────────────────────────────────────────

// id → the query's readable key, for the readers that print a result's query. Built from a table
// already in hand, so following the relation costs nothing.
const keyById = (rows: Row[]): ((id: string) => string) => {
	const m = new Map(rows.map((r) => [r.id, String(r.fields.Key ?? "")]));
	return (id) => m.get(id) ?? "";
};

export const tools = {
	prompts: {
		add: async (texts: string[]) =>
			batch(texts, async (t) => {
				const r = await writePrompt(t);
				return { prompt: promptKey(t), created: r.created, url: r.url };
			}),

		// The index: one line per prompt, everything derived from its answers. Two reads of two small
		// tables and a group-by ON THE RELATION — which is the whole reason no counts are stored.
		get: async (o: PromptSelect = {}) => {
			const [prompts, answers] = await Promise.all([
				queryAll(store, PROMPTS, promptFilter(o)),
				queryAll(store, ANSWERS, ALL_ANSWERS)
			]);
			const views = prompts.map((p) => promptView(p, answers));
			const kept = o.verdict ? views.filter((v) => v.verdict === o.verdict) : views;
			return newest(kept, (v) => String(v.lastAsked ?? ""), o.limit);
		}
	},

	answers: {
		// One line per draw. The answer TEXT is not here: it is the biggest column in the schema and a
		// list of ten draws must not be half a megabyte. `show` prints one.
		get: async (o: AnswerSelect = {}) => {
			const [rows, prompts, queries] = await Promise.all([
				queryAll(store, ANSWERS, { and: [all("Name"), ...(o.provider ? [{ property: "Provider", select: { equals: o.provider } }] : [])] }),
				queryAll(store, PROMPTS, promptFilter({ prompt: o.prompt })),
				queryAll(store, QUERIES, ALL_QUERIES)
			]);
			const wanted = new Set(prompts.map((p) => p.id));
			const promptText = new Map(prompts.map((p) => [p.id, String(p.fields.Prompt ?? "")]));
			const qKey = keyById(queries);
			const views = rows
				.filter((r) => (r.rel.Prompt ?? []).some((id) => wanted.has(id)))
				.map((r) => ({
					prompt: promptText.get((r.rel.Prompt ?? [])[0]) ?? null,
					provider: r.fields.Provider ?? null,
					model: r.fields.Model ?? null,
					askedAt: String(r.fields["Asked at"] ?? ""),
					verdict: verdictOf(drawOf(r)),
					queries: (r.rel.Queries ?? []).map(qKey),
					sources: lines(r.fields.Sources).length,
					readUs: lines(r.fields.Sources).filter(ours),
					conversation: r.fields.Conversation ?? null
				}));
			const kept = o.verdict ? views.filter((v) => v.verdict === o.verdict) : views;
			return newest(kept, (v) => v.askedAt, o.limit);
		},

		// One draw in full — the answer text included, which is what you read when the verdict says
		// `Passed over` and you want to know what it said instead.
		show: async (o: AnswerSelect = {}) => {
			const [rows, prompts, queries] = await Promise.all([
				queryAll(store, ANSWERS, ALL_ANSWERS),
				queryAll(store, PROMPTS, promptFilter({ prompt: o.prompt })),
				queryAll(store, QUERIES, ALL_QUERIES)
			]);
			const wanted = new Set(prompts.map((p) => p.id));
			const promptText = new Map(prompts.map((p) => [p.id, String(p.fields.Prompt ?? "")]));
			const qKey = keyById(queries);
			return newest(
				rows.filter((r) => (r.rel.Prompt ?? []).some((id) => wanted.has(id))),
				(r) => String(r.fields["Asked at"] ?? ""),
				o.limit ?? 1
			).map((r) => ({
				prompt: promptText.get((r.rel.Prompt ?? [])[0]) ?? null,
				provider: r.fields.Provider ?? null,
				askedAt: r.fields["Asked at"] ?? null,
				stopReason: r.fields["Stop reason"] ?? null,
				verdict: verdictOf(drawOf(r)),
				queries: (r.rel.Queries ?? []).map(qKey),
				sources: lines(r.fields.Sources),
				answer: String(r.fields.Answer ?? "")
			}));
		}
	},

	queries: {
		// An AUTHORED query — an own-domain probe is not a feature, it is a query you write instead of
		// harvest. Same row, same search stage, same result rows. Provenance stays visible WITHOUT a
		// column: a harvested query is one some answer points at, which the relation now says outright.
		add: async (texts: string[], engine: string = engineOf(DEFAULT_PROVIDER)) =>
			batch(texts, async (t) => {
				const key = queryKey(engine, t);
				const r = await writeQuery(key, { Engine: engine as GEOQueries["Engine"], Query: t.trim().toLowerCase() });
				return { query: key, created: r.created, url: r.url };
			}),

		get: async (o: QuerySelect = {}) => {
			const rows = await queryAll(store, QUERIES, queryFilter(o));
			return newest(
				rows.map((r) => ({
					query: String(r.fields.Key ?? ""),
					engine: r.fields.Engine ?? null,
					// Both read straight off this row's own duals — no second table, no counting pass.
					// This is what the relation bought: the joins the parent needs fill themselves.
					source: (r.rel.Answers ?? []).length ? "harvested" : "authored",
					draws: (r.rel.Answers ?? []).length,
					searchedAt: r.fields["Searched at"] ?? null,
					results: r.fields["Searched at"] ? (r.rel.Results ?? []).length : null
				})),
				(v) => String(v.searchedAt ?? ""),
				o.limit
			);
		}
	},

	results: {
		get: async (o: ResultSelect = {}) => {
			// ONE read: a result names its own query off its key, so nothing here follows a relation.
			const views = (await queryAll(store, RESULTS, resultFilter(o))).map(resultView);
			// `--unreadable` post-filters rather than pushing into the store, because `readable` needs
			// two columns compared against each other and a Notion filter cannot express that. It is a
			// reading of a set the store already narrowed, so it costs nothing.
			const kept = o.unreadable ? views.filter((r) => r.readable === false) : views;
			return newest(kept, (r) => String(r.rank ?? 999).padStart(4, "0"), o.limit).reverse();
		}
	},

	// pending — what each stage owes, without spending anything. It compiles the SAME filters the
	// stages drain, so a count can never describe a different set than the run.
	pending: async (draws = 1, o: PromptSelect = {}) => {
		const [prompts, answers, queries, results] = await Promise.all([
			queryAll(store, PROMPTS, promptFilter(o)),
			queryAll(store, ANSWERS, ALL_ANSWERS),
			queryAll(store, QUERIES, UNSEARCHED),
			queryAll(store, RESULTS, unread())
		]);
		const owed = prompts.filter((p) => promptView(p, answers).asks < draws);
		return {
			ask: { owed: owed.length, of: prompts.length, prompts: owed.map((p) => String(p.fields.Prompt)) },
			search: { owed: queries.length },
			read: { owed: results.length, brand: brandStamp() }
		};
	},

	// The three stages over everything owed. `search` and `read` drain (processing moves a row out of
	// the filter, so re-querying pages the backlog with no cursor); `ask` cannot, because "fewer than
	// N answers" is not expressible as a Notion filter — so it reads both small tables and counts
	// here. Prompts are a hand-written list of tens, so that read is one query and costs nothing.
	askPending: async (draws = 1, provider: string = DEFAULT_PROVIDER, o: PromptSelect = {}) => {
		const out: unknown[] = [];
		for (let round = 0; round < draws; round++) {
			const [prompts, answers] = await Promise.all([
				queryAll(store, PROMPTS, promptFilter(o)),
				queryAll(store, ANSWERS, ALL_ANSWERS)
			]);
			const owed = prompts.filter((p) => promptView(p, answers).asks < draws).map((p) => String(p.fields.Prompt ?? ""));
			if (!owed.length) break;
			// One round at a time, re-reading between them: a draw is only evidence if the ones before
			// it already landed, and this is what makes a crashed run resume at the right count.
			out.push(...(await batch(owed, (p) => ask(p, provider), `ask (round ${round + 1}/${draws})`)));
		}
		return out;
	},

	searchPending: async () => drain(store, QUERIES, UNSEARCHED, async (r) => (await searchQueries([r]))[0], "search"),

	readPending: () => drain(store, RESULTS, unread(), readResult, "read"),

	// One pass over the whole loop. The stages are strictly ordered — a query only exists once an
	// answer issued it, a result only once a query was searched — so one command is one pass.
	advance: async (draws = 1, provider: string = DEFAULT_PROVIDER, o: PromptSelect = {}) => ({
		ask: await tools.askPending(draws, provider, o),
		search: await tools.searchPending(),
		read: await tools.readPending()
	})
};
