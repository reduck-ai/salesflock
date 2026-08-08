// geo tools — the funnel. Three stages joined by the store, and what marks a row's place is DATA a
// previous stage HAD to write, never a status anyone maintains:
//
//   ask     one assistant, one prompt, one draw → an Answer row (the answer, the sources it read),
//           a Query row per reformulation, and a Result row per SOURCE which it then reads on the
//           spot. Owed while the prompt has fewer than `--draws` answers that measured something.
//   search  one query on its engine → a Result row per ranked page. Owed while `Searched at` is empty.
//   read    one page over plain HTTP → status, text length, mention count, and the page itself in the
//           row's body. Owed while `Fetched at` is empty, OR while its `Brand` stamp is not today's.
//
// ONE FETCHER, TWO CALLERS (`readPage`): the read stage drains what is owed, and `ask` calls it
// inline for the pages it just saw. A page an assistant READ and a page a query RANKED are the same
// kind of thing — a document on the web we have looked at — so they are one table, one fetch and one
// set of columns, told apart by the key: `sources:<provider>` where a query key would sit.
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
	queryParts
} from "../../src/clients/geo/index.js";
import { sinceIso } from "../../src/time.js";
import type { RunOpts } from "../../src/clients/reduck.js";
import config, { BRAND, brandStamp, DEFAULT_PROVIDER, ENGINES, PROVIDERS, engineOf } from "./config.js";
import type { GEOAnswers } from "./schema/GEOAnswers.js";
import type { GEOPrompts } from "./schema/GEOPrompts.js";
import type { GEOQueries } from "./schema/GEOQueries.js";
import type { GEOResults } from "./schema/GEOResults.js";

const store = getStore(config.destination);
// The four tables, read at CALL time. A table id belongs to the installation (src/models.ts), so
// destructuring it here would read every id the moment this module is imported — and an unconfigured
// clone would then fail on `import` rather than inside the command, past the CLI's own error handler.
const T = config.models;

// ─── the writes: one per table, and the ONE place each identity key is minted ────────────────────
//
// The key is a positional argument and the field map's type forbids it, for the reason reddit-engage
// gives at the same seam: a caller that supplies its own key can mis-spell it, and Notion answers a
// non-canonical key by CREATING A SECOND PAGE — silent on the way in, permanent once made, and
// invisible to every filter here. Minting it here makes that unreachable rather than merely unlikely.

const writePrompt = (prompt: string, fields: Omit<Partial<GEOPrompts>, "Prompt"> = {}) =>
	store.upsert(T.GEOPrompts, { ...fields, Prompt: promptKey(prompt) }, "Prompt");

// An answer is CREATED, never upserted: it accumulates. Three draws of one prompt are three rows,
// because the assistant answers differently each time and that variance IS the measurement. It also
// needs no identity column at all — nothing ever looks one up by key.
const writeAnswer = (fields: GEOAnswers) => store.create(T.GEOAnswers, fields);

const writeQuery = (key: string, fields: Omit<Partial<GEOQueries>, "Key"> = {}) =>
	store.upsert(T.GEOQueries, { ...fields, Key: key }, "Key");

// An observation is CREATED, never upserted, and that is the whole correction. It used to be keyed
// on `<query> :: <url>`, so re-searching a query OVERWROTE its previous rank — the store could only
// ever say where a page stood today, never that it had moved. A ranking is not a property of a page,
// it is something that happened at a moment; so is a reading. Both belong on a row whose identity IS
// that moment, beside the query or the answer that occasioned it.
//
// It takes no key for the same reason `writeAnswer` takes none: nothing ever looks one up. They are
// reached through their relations, and read newest-first.
const createResult = (fields: GEOResults) => store.create(T.GEOResults, fields);

// WHERE a run went, as one short string on the observation — `cloud/us-east-1`, `device:c12b4b27`.
// Derived from the target actually used rather than from config, so the stamp cannot disagree with
// where the browser was. It is not a detail: a residential US proxy, a datacenter and a laptop are
// three different measurements of Brave, and without this the rows are indistinguishable.
const egressOf = (opts: RunOpts): string => {
	const t = opts.target ?? "extension";
	const at = typeof t === "string" ? t : `device:${t.deviceId.slice(0, 8)}`;
	return `${at}${opts.country ? `/${opts.country}` : ""}${opts.region ? `/${opts.region}` : ""}`;
};

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

// What kind of page this is — the dimension that turned out to carry the analysis, and the one a
// GEO decision actually chooses between: somebody else's community thread, somebody else's article,
// a vendor's own marketing, the platform's own docs. Each implies a different action, and none of
// them is a fact worth storing: it is a function of the URL, so it is computed at read time.
export const kindOf = (url: string): string => {
	const host = (() => {
		try {
			return new URL(url).hostname.replace(/^www\./, "");
		} catch {
			return "";
		}
	})();
	if (/reddit\.com/.test(host)) return "UGC forum";
	if (/g2\.com|capterra|getapp|softwareadvice|trustpilot|slashdot/.test(host)) return "review site";
	if (/linkedin|medium|substack|dev\.to|quora|stackoverflow|news\.ycombinator|x\.com|twitter/.test(host)) return "UGC social";
	if (/youtube|vimeo/.test(host)) return "video";
	if (/github\.com/.test(host)) return "code";
	if (/anthropic\.com|claude\.com|openai\.com/.test(host) || /^docs?\./.test(host) || /\/docs?\//.test(url)) return "platform docs";
	if (/\/blog\/|\/blogs\/|\/resources\/|\/guides?\/|\/learn\/|\/articles?\/|\/\d{4}\/\d{2}\//.test(url)) return "vendor blog";
	return "other/marketing";
};

// `qKey` is the id→key resolver for the Query relation: the caller holds one read of the Queries
// table, so following the join costs nothing. Absent ⇒ the query reads as null rather than wrong.
export const resultView = (r: Row, qKey: (id: string) => string = () => "") => {
	const url = String(r.fields.URL ?? "");
	const status = Number(r.fields.Status ?? 0);
	const len = Number(r.fields["Text length"] ?? 0);
	const fetched = !!r.fields["Fetched at"];
	return {
		url,
		// WHEN, and from WHERE. An observation without its instant is the row this table used to hold —
		// a rank with no way to tell whether it is today's or a month old.
		observedAt: r.fields["Observed at"] ?? r.fields["Fetched at"] ?? null,
		egress: r.fields.Egress ?? null,
		// The query, through the relation — `qKey` is the id→key map the caller already built from one
		// read of the (small) Queries table. It used to be parsed out of this row's key, which is how
		// the key came to be load-bearing and therefore unable to accumulate.
		query: (r.rel.Query ?? []).map((id) => qKey(id)).filter(Boolean)[0] ?? null,
		rank: r.fields.Rank ?? null,
		title: r.fields.Title ?? null,
		snippet: r.fields.Snippet ?? null,
		age: r.fields.Age ?? null,
		// WHY we looked at this page: a query RANKED it, or an answer READ it. Both are relations now,
		// so the row says which without a prefix encoded into a key.
		source: (r.rel.Answers ?? []).length > 0,
		// What KIND of page — derived, never stored, for the reason `ours` and `readable` are: it is a
		// function of the URL under today's rules, so improving the classifier reclassifies the whole
		// corpus instead of leaving old labels behind.
		kind: kindOf(url),
		ours: url ? ours(url) : false,
		fetchedAt: r.fields["Fetched at"] ?? null,
		finalUrl: r.fields["Final URL"] ?? null,
		error: r.fields.Error ?? null,
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
	source?: boolean; // only pages an assistant READ
	ranked?: boolean; // only pages a query RANKED
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
	const k = q.trim().toLowerCase();
	if (q.includes(":") && ENGINES[queryParts(q).engine as keyof typeof ENGINES]) return k;
	return queryKey(engineOf(DEFAULT_PROVIDER), q);
};
const queryFilter = (o: QuerySelect): object => ({
	and: [
		all("Key"),
		...anyOf((o.query ?? []).map((q) => ({ property: "Key", title: { equals: normQuery(q) } }))),
		...(o.engine ? [{ property: "Key", title: { starts_with: `${o.engine.toLowerCase()}:` } }] : [])
	]
});

// An observation is narrowed by its RELATIONS now, not by a prefix of its key — the key is gone, and
// with it the trick of encoding the query into the row's identity. `--query` therefore resolves the
// query row first and filters on `contains` (Notion's only relation predicate); a caller that names
// no query pays for no lookup.
const resultFilter = async (o: ResultSelect): Promise<object> => {
	const ids: string[] = [];
	for (const q of o.query ?? []) {
		const [row] = await store.query(T.GEOQueries, { property: "Key", title: { equals: normQuery(q) } });
		if (!row) throw new Error(`no query "${normQuery(q)}" — nothing has searched it`);
		ids.push(row.id);
	}
	return {
		and: [
			all("Name"),
			...anyOf(ids.map((id) => ({ property: "Query", relation: { contains: id } }))),
			...anyOf((o.url ?? []).map((u) => ({ property: "URL", url: { equals: canonicalUrl(u) } }))),
			// `--ours` needs no `Ours` column: the domain is in the URL, which is why the boolean was
			// never worth storing. `--source` is now the Answers relation rather than a key prefix.
			...(o.ours ? [{ property: "URL", url: { contains: BRAND.domain } }] : []),
			...(o.source ? [{ property: "Answers", relation: { is_not_empty: true } }] : []),
			...(o.ranked ? [{ property: "Query", relation: { is_not_empty: true } }] : []),
			...(o.mentions ? [{ property: "Mentions", number: { greater_than: 0 } }] : [])
		]
	};
};

// ─── what is owed ────────────────────────────────────────────────────────────────────────────────

// A query owes a search when it has never been searched — and, with `--again`, when the last one is
// older than the window you name. That second clause is what turns the store into a series: the same
// query searched twice is two observations, and only re-searching produces the second one. Opt-in,
// so a routine run never silently spends a browser on work nobody asked for.
const unsearched = (again?: string): object => ({
	and: [
		all("Key"),
		again
			? { or: [{ property: "Searched at", date: { is_empty: true } }, { property: "Searched at", date: { before: sinceIso(again) } }] }
			: { property: "Searched at", date: { is_empty: true } }
	]
});
const UNSEARCHED = unsearched();

// A result owes a read when it has never been fetched, OR when what it counted is no longer what
// "us" means. The second clause is the `Brand` stamp paying for itself: adding an alias to BRAND puts
// every counted result back in this set automatically, with no migration and nothing to remember.
const unread = (): object => ({
	and: [
		all("Name"),
		{
			or: [
				{ property: "Fetched at", date: { is_empty: true } },
				{ property: "Brand", rich_text: { does_not_equal: brandStamp() } }
			]
		}
	]
});

// NAMING pages is the manual door, and it does NOT ask whether they are owed: saying a URL out loud
// is saying "fetch this now" — the point of a by-hand read is to look again at something you are
// working on. Every other read stays derived from the data (`unread` above), so this cannot make the
// backlog quietly disappear: it addresses rows, one at a time, by the identity you typed.
const named = (urls: readonly string[]): object => ({
	and: [all("Name"), ...anyOf(urls.map((u) => ({ property: "URL", url: { equals: canonicalUrl(u) } })))]
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

	// Each SOURCE becomes an observation too — the pages that provably reached the model, which is the
	// one set worth reading and the one set nothing used to fetch. Same table and same stages as a
	// ranked hit, and now the same SHAPE: an observation with no query, whose `Answers` relation says
	// who read it. It used to need a synthetic `sources:<provider>` key to occupy a query key's slot;
	// an event has no key, so that whole encoding stopped being necessary.
	//
	// A URL too malformed to canonicalize gets no row and stays in the `Sources` text below — which is
	// why that column is kept: it is what the script REPORTED, this is what we could resolve of it.
	const canon = [
		...new Set(
			sources.flatMap((u) => {
				try {
					return [canonicalUrl(u)];
				} catch {
					return [];
				}
			})
		)
	];
	const pageRefs = await mapLimit(canon, (u) =>
		createResult({ Name: `read · ${u.slice(8, 70)}`, URL: u, "Observed at": askedAt, Egress: egressOf(spec.target) })
	);

	const fields: GEOAnswers = {
		Name: `${p.slice(0, 60)} — ${provider} — ${askedAt.slice(0, 19).replace("T", " ")}`,
		Prompt: [promptRef.id],
		Queries: queryRefs.map((r) => r.id),
		// Written from the ANSWER, whose source list is complete the moment it is written — the same rule
		// `Queries` follows. Notion syncs the dual, so each page's `Answers` fills itself and nothing here
		// appends to a list it would have had to read back first.
		Pages: pageRefs.map((r) => r.id),
		Provider: provider as GEOAnswers["Provider"],
		Model: spec.model,
		"Asked at": askedAt,
		Conversation: a.conversationId,
		"Stop reason": a.stopReason ?? "",
		Answer: a.answer,
		// Sources stay RAW TEXT beside the relation, and the two are different facts rather than one fact
		// twice: this is the list the script REPORTED, verbatim, while `Pages` is what we resolved it to
		// (canonicalized, deduped, and short a URL that would not parse). Keeping it is also what lets
		// `verdictOf` stay a pure function of one row — "did it read us" is answered fresh under today's
		// BRAND, off the text, with no second table to join.
		Sources: sources.join("\n")
	};
	const ref = await writeAnswer(fields);

	// …and now READ them, in the same command. A source is a page that provably reached the model, so
	// "what did it answer" and "what was it looking at" are one question, and asking them separately
	// meant the second one never got asked at all.
	//
	// AFTER the answer is written, deliberately: the ask is the expensive, unrepeatable part (a draw is
	// a draw — the same prompt answers differently next time), so nothing that can fail is allowed to
	// stand between it and its record. A fetch that fails is caught and left unfetched, which puts the
	// row straight into what `geo read` owes — no special case, and no draw lost to a dead socket.
	const read = await mapLimit(
		pageRefs,
		(r, i) =>
			readPage(r.id, canon[i]).catch((e: unknown) => {
				log("read", `${canon[i]} → ${renderError(e)} (left unfetched — \`geo read\` will retry)`);
				return null;
			}),
		{ label: `read sources for ${p.slice(0, 32)}` }
	);

	const verdict = verdictOf({ stopReason: a.stopReason ?? "", queries: queries.length, sources, answer: a.answer });
	log(
		"ask",
		`${p.slice(0, 48)} @${provider} → ${verdict} (${queries.length} queries, ${sources.length} sources, ` +
			`${read.filter(Boolean).length}/${pageRefs.length} read)`
	);
	return {
		prompt: p,
		provider,
		verdict,
		queries,
		sources: sources.length,
		pages: read.filter(Boolean),
		answer: ref.url
	};
};

// search — one query on its engine, and its results point back at it.
//
// `operatorsApplied: false` is the one guard: Brave found too few documents matching the operator,
// dropped it, and answered a relaxed query over the whole web. Those hits are not evidence about the
// operator, so none are written — but the REASON is, on the query's `Error`. Recording nothing made
// "Brave refused the operator" and "nothing matched" and "never tried" the same row.
export const searchQueries = async (rows: Row[], target: RunOpts = ENGINES.brave.target) => {
	if (!rows.length) return [];
	const keys = rows.map((r) => String(r.fields.Key));
	const observedAt = new Date().toISOString();
	const egress = egressOf(target);
	const outcomes = await searchAll(keys.map((k) => queryParts(k).query), target);
	return mapLimit(rows, async (row, i) => {
		const key = keys[i];
		const outcome = outcomes[i];
		if (outcome.status === "rejected") {
			// The failure is a fact about this attempt, so it lands on the row. `Searched at` stays empty,
			// which is what keeps the query owed and retried — the error only says why the last try failed.
			const error = renderError(outcome.reason);
			await writeQuery(key, { Error: error }).catch(() => undefined);
			return { query: key, error };
		}
		const s = outcome.value;
		const relaxed = !s.operatorsApplied;
		const hits = relaxed ? [] : s.results;
		await mapLimit(hits, (r, rank) =>
			createResult({
				Name: `${key.slice(0, 40)} · rank ${rank + 1} · ${observedAt.slice(0, 16).replace("T", " ")}`,
				Query: [row.id], // written from the child; Query.Results fills itself
				"Observed at": observedAt,
				Egress: egress,
				URL: canonicalUrl(r.url),
				Rank: rank + 1,
				Title: r.title,
				Snippet: r.snippet ?? undefined,
				Age: r.age ?? undefined
			}).catch(() => undefined)
		);
		// `Searched at` is the drain's cursor — the instant of the MOST RECENT search, which is the one
		// thing a Notion filter cannot compute over the observations themselves. `Error` is cleared on a
		// clean run, so the column always describes the latest attempt and never an old one.
		await writeQuery(key, {
			"Searched at": observedAt,
			Error: relaxed ? "Brave dropped the operators and answered a relaxed query — no results recorded" : ""
		});
		log("search", `${key} → ${hits.length} results @${egress}${relaxed ? " (operators dropped — relaxed query, not recorded)" : ""}`);
		return { query: key, results: hits.length, egress, ...(relaxed ? { relaxed: true } : {}) };
	});
};

// readPage — one page over plain HTTP: can a crawler read it, does it name us, and what does it
// actually say. No browser, because a crawler has none either: a page that only renders in one is a
// page a crawler cannot read, and that IS the finding.
//
// It takes an ID AND A URL rather than a Row, because it has two callers and only one of them holds
// a row: the read stage drains rows, while `ask` has just created one and would otherwise have to
// read back a page it wrote a line ago. Both facts are all this needs.
//
// The BODY is the page as served (`store.setBody`, raw HTML), and it is what a status alone cannot
// give you. Measured: producthunt.com answers 403 with 5.7 KB reading "Just a moment" — a Cloudflare
// wall, not a refusal aimed at us — and adsx.com answers 404 for a page Brave still ranks at #10.
// Both look like one number in a column and like two different problems in the markup.
export const readPage = async (id: string, url: string) => {
	if (!url) throw new Error(`result ${id} has no URL`);
	const got = await http.get(url);
	const mentions = http.count(got.text, BRAND.aliases);
	await store.patch(T.GEOResults, id, {
		// A NETWORK-level failure is not an answer ABOUT the page. A timeout, a DNS blip or a dead
		// socket says nothing about whether a crawler can read it — and stamping `Fetched at` would
		// freeze that blip as a fact forever, because the row leaves the unread set and is never tried
		// again. So it is left unstamped and stays owed: `eliminate on evidence, never on absence`,
		// applied to our own network. An HTTP status — 403, 404, 500 — IS the server ruling, so it lands.
		...(got.status ? { "Fetched at": new Date().toISOString() } : {}),
		Status: got.status,
		"Text length": got.text.length,
		Mentions: mentions,
		// Where the redirects ended, and why there is no status. Both come back from every fetch and
		// were being dropped: a soft-404 landing on the homepage is only visible in the first, and a
		// row reading `Status: 0` with nothing beside it is a failure nobody can diagnose.
		"Final URL": got.finalUrl,
		Error: got.error ?? "",
		// The stamp travels with the count it qualifies, in the same write — so there is no instant at
		// which a count exists without the definition it was made under.
		Brand: brandStamp()
	});
	await store.setBody(id, got.html, "html");
	return {
		url,
		status: got.status,
		textLength: got.text.length,
		htmlLength: got.html.length,
		mentions,
		...(got.finalUrl !== url ? { finalUrl: got.finalUrl } : {}),
		...(got.error ? { error: got.error } : {})
	};
};

// The page back out of the body, without the code fence. `store.body` renders a page as MARKDOWN, so
// the blocks `setBody` wrote come back wrapped in ```html — the store's rendering of what it holds,
// not a thing the page contains. Three exact edits rather than a fence parser: the opening fence, the
// closing one, and the seam between two consecutive blocks (a page over 200 000 chars spans several).
// Anything else that looks like a fence is the page's own and is left alone.
const unfence = (markdown: string): string =>
	markdown
		.replace(/^```html\n/, "")
		.replace(/\n```$/, "")
		.replace(/\n```\n\n```html\n/g, "");

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
				queryAll(store, T.GEOPrompts, promptFilter(o)),
				queryAll(store, T.GEOAnswers, ALL_ANSWERS)
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
				queryAll(store, T.GEOAnswers, { and: [all("Name"), ...(o.provider ? [{ property: "Provider", select: { equals: o.provider } }] : [])] }),
				queryAll(store, T.GEOPrompts, promptFilter({ prompt: o.prompt })),
				queryAll(store, T.GEOQueries, ALL_QUERIES)
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
				queryAll(store, T.GEOAnswers, ALL_ANSWERS),
				queryAll(store, T.GEOPrompts, promptFilter({ prompt: o.prompt })),
				queryAll(store, T.GEOQueries, ALL_QUERIES)
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
			const rows = await queryAll(store, T.GEOQueries, queryFilter(o));
			return newest(
				rows.map((r) => ({
					query: String(r.fields.Key ?? ""),
					engine: r.fields.Engine ?? null,
					// Both read straight off this row's own duals — no second table, no counting pass.
					// This is what the relation bought: the joins the parent needs fill themselves.
					source: (r.rel.Answers ?? []).length ? "harvested" : "authored",
					draws: (r.rel.Answers ?? []).length,
					searchedAt: r.fields["Searched at"] ?? null,
					// Every observation ever made of this query, not the last search's count — which is what
					// "how much do we know about this query" now means.
					observations: (r.rel.Results ?? []).length,
					// WHY the last attempt came back empty: refused at the door, or Brave dropping the
					// operators. Without it a query with no results looks the same whether we failed to ask
					// or asked and got nothing.
					error: r.fields.Error ?? null
				})),
				(v) => String(v.searchedAt ?? ""),
				o.limit
			);
		}
	},

	results: {
		get: async (o: ResultSelect = {}) => {
			// TWO reads, and the second is the whole queries table — small, and it is what turns each
			// observation's `Query` relation back into readable text. The key used to carry it; an event
			// has no key, so the join does the job the encoding was standing in for.
			const [rows, queries] = await Promise.all([
				resultFilter(o).then((f) => queryAll(store, T.GEOResults, f)),
				queryAll(store, T.GEOQueries, ALL_QUERIES)
			]);
			const qKey = keyById(queries);
			const views = rows.map((r) => resultView(r, qKey));
			// `--unreadable` post-filters rather than pushing into the store, because `readable` needs
			// two columns compared against each other and a Notion filter cannot express that. It is a
			// reading of a set the store already narrowed, so it costs nothing. `--ranked` is here for a
			// duller reason: Notion has `starts_with` and no negation of it.
			const kept = views.filter((r) => !o.unreadable || r.readable === false);
			// NEWEST FIRST, on the instant — because there are several observations of one page now, and
			// the question is almost always "where does it stand", with the older rows underneath as the
			// history. Rank orders within one moment; time orders the moments.
			return newest(kept, (r) => String(r.observedAt ?? ""), o.limit);
		},

		// show — one page's stored BODY: what we actually captured, as served. The counterpart of
		// `answers show`, and the reason the body is worth storing at all — a status says a crawler was
		// refused, the markup says whether it was a bot wall, a soft 404 or an empty JavaScript shell.
		//
		// A URL can hold more than one row (a query ranked it AND an assistant read it, which are two
		// different observations of one page), so this answers for every row it matches rather than
		// picking one and hiding the rest — the same rule that keeps `site:` samples honest.
		show: async (url: string) => {
			const [rows, queries] = await Promise.all([
				queryAll(store, T.GEOResults, named([url])),
				queryAll(store, T.GEOQueries, ALL_QUERIES)
			]);
			if (!rows.length) throw new Error(`no observation of ${canonicalUrl(url)} — nothing has looked at it`);
			const qKey = keyById(queries);
			return mapLimit(
				newest(rows, (r) => String(r.fields["Observed at"] ?? r.fields["Fetched at"] ?? "")),
				async (r) => ({ ...resultView(r, qKey), html: r.fields["Fetched at"] ? unfence(await store.body(r.id)) : null })
			);
		}
	},

	// chain — THE measurement, and the reason the other three stages exist. An answer can only cite
	// what its tools retrieved, so the question that decides whether any of this is worth doing is:
	// of the pages the assistant actually READ, how many did the engine RANK for the query the
	// assistant itself issued?
	//
	// Both halves are already in the store — `Answer.Pages` is what it read, `Query.Results` is what
	// ranked — and nothing joined them, so the number lived in a throwaway script. It is pure
	// derivation: three reads of small tables, no browser, no write.
	//
	// A source read at rank 11 counts exactly as much as one at rank 1: the assistant reads down the
	// page, so PRESENCE in the ranked set is the fact, and the rank beside it is how comfortably.
	chain: async (o: AnswerSelect = {}) => {
		const [answers, prompts, queries, results] = await Promise.all([
			queryAll(store, T.GEOAnswers, ALL_ANSWERS),
			queryAll(store, T.GEOPrompts, promptFilter({ prompt: o.prompt })),
			queryAll(store, T.GEOQueries, ALL_QUERIES),
			queryAll(store, T.GEOResults, { and: [all("Name")] })
		]);
		const wanted = new Set(prompts.map((p) => p.id));
		const promptText = new Map(prompts.map((p) => [p.id, String(p.fields.Prompt ?? "")]));
		const qKey = keyById(queries);
		// url → the best (lowest) rank it ever held for this query, across every observation of it.
		const rankFor = (queryIds: string[]) => {
			const m = new Map<string, number>();
			for (const r of results) {
				if (!(r.rel.Query ?? []).some((id) => queryIds.includes(id))) continue;
				const url = String(r.fields.URL ?? "");
				const rank = Number(r.fields.Rank ?? 0);
				if (url && rank && (!m.has(url) || rank < m.get(url)!)) m.set(url, rank);
			}
			return m;
		};
		const views = answers
			.filter((a) => (a.rel.Prompt ?? []).some((id) => wanted.has(id)))
			.map((a) => {
				const queryIds = a.rel.Queries ?? [];
				const ranked = rankFor(queryIds);
				const sources = lines(a.fields.Sources).flatMap((u) => {
					try {
						return [canonicalUrl(u)];
					} catch {
						return [];
					}
				});
				const at = sources.map((u) => ({ url: u, rank: ranked.get(u) ?? null }));
				return {
					prompt: promptText.get((a.rel.Prompt ?? [])[0]) ?? null,
					askedAt: String(a.fields["Asked at"] ?? ""),
					verdict: verdictOf(drawOf(a)),
					queries: queryIds.map(qKey),
					read: sources.length,
					ranked: at.filter((x) => x.rank !== null).length,
					ranks: at.filter((x) => x.rank !== null).map((x) => x.rank),
					// The ones it read that we never saw ranked: either the query was never searched, or the
					// assistant reached them some other way. Both are worth seeing rather than averaging away.
					unranked: at.filter((x) => x.rank === null).map((x) => x.url)
				};
			});
		const scored = views.filter((v) => v.read > 0);
		return {
			overall: {
				draws: scored.length,
				read: scored.reduce((s, v) => s + v.read, 0),
				ranked: scored.reduce((s, v) => s + v.ranked, 0)
			},
			draws: newest(views, (v) => v.askedAt, o.limit)
		};
	},

	// pending — what each stage owes, without spending anything. It compiles the SAME filters the
	// stages drain, so a count can never describe a different set than the run.
	pending: async (draws = 1, o: PromptSelect = {}, again?: string) => {
		const [prompts, answers, queries, results] = await Promise.all([
			queryAll(store, T.GEOPrompts, promptFilter(o)),
			queryAll(store, T.GEOAnswers, ALL_ANSWERS),
			queryAll(store, T.GEOQueries, unsearched(again)),
			queryAll(store, T.GEOResults, unread())
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
				queryAll(store, T.GEOPrompts, promptFilter(o)),
				queryAll(store, T.GEOAnswers, ALL_ANSWERS)
			]);
			const owed = prompts.filter((p) => promptView(p, answers).asks < draws).map((p) => String(p.fields.Prompt ?? ""));
			if (!owed.length) break;
			// One round at a time, re-reading between them: a draw is only evidence if the ones before
			// it already landed, and this is what makes a crashed run resume at the right count.
			out.push(...(await batch(owed, (p) => ask(p, provider), `ask (round ${round + 1}/${draws})`)));
		}
		return out;
	},

	// The search drain, BOUNDED. `drain` fans a page out through `batch`, which is unbounded — fine
	// against the cloud, where each script gets its own browser and its own address, and actively
	// harmful against a device, where they all leave from one. Measured: six concurrent searches from
	// this machine earned it an HTTP 429 and a captcha page from Brave, which then applied to ordinary
	// browsing too. So the width follows the target: many when the addresses are many, one when it is one.
	searchPending: async (again?: string) => {
		const target = ENGINES.brave.target as RunOpts;
		const local = typeof target.target !== "string";
		return drain(store, T.GEOQueries, unsearched(again), async (r) => (await searchQueries([r], target))[0], "search", {
			limit: local ? 1 : undefined
		});
	},

	// The drain, plus the by-hand door: name URLs and it reads exactly those, whatever state they are
	// in; name none and it reads everything owed.
	readPending: (urls?: readonly string[]) =>
		drain(
			store,
			T.GEOResults,
			urls?.length ? named(urls) : unread(),
			(r) => readPage(r.id, String(r.fields.URL ?? "")),
			"read"
		),

	// One pass over the whole loop. The stages are strictly ordered — a query only exists once an
	// answer issued it, a result only once a query was searched — so one command is one pass.
	advance: async (draws = 1, provider: string = DEFAULT_PROVIDER, o: PromptSelect = {}, again?: string) => ({
		ask: await tools.askPending(draws, provider, o),
		search: await tools.searchPending(again),
		read: await tools.readPending()
	}),

	// domains — how much each domain in the corpus PUBLISHES, which is the dimension that separated the
	// winners once anything else stopped predicting rank. Computed on demand from each site's own
	// sitemap and stored NOWHERE: it is a fact about a domain rather than about any row we hold, it
	// changes on its own schedule, and a stored number would need a stamp to stay honest (the job
	// `Brand` already does for a mention count, and one of those is enough).
	domains: async (o: ResultSelect = {}) => {
		const rows = await queryAll(store, T.GEOResults, await resultFilter(o));
		const hosts = new Map<string, { rows: number; best: number }>();
		for (const r of rows) {
			const url = String(r.fields.URL ?? "");
			if (!url) continue;
			let host: string;
			try {
				host = new URL(url).hostname.replace(/^www\./, "");
			} catch {
				continue;
			}
			const rank = Number(r.fields.Rank ?? 0) || 999;
			const cur = hosts.get(host) ?? { rows: 0, best: 999 };
			hosts.set(host, { rows: cur.rows + 1, best: Math.min(cur.best, rank) });
		}
		const scale = await mapLimit(
			[...hosts.keys()],
			async (host) => {
				const sm = await http.get(`https://${host}/sitemap.xml`);
				let locs = [...sm.html.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
				// A sitemap INDEX points at more sitemaps; read the first few rather than the whole tree —
				// this is a scale reading, not an inventory, and it says so by reporting what it read.
				const nested = locs.length && locs.every((l) => /\.xml/.test(l)) ? locs.length : 0;
				if (nested) {
					const kids = await mapLimit(locs.slice(0, 8), (u) => http.get(u).catch(() => ({ html: "" })), { limit: 4 });
					locs = kids.flatMap((k) => [...k.html.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()));
				}
				const posts = locs.filter((u) => /\/blog\/|\/post\/|\/articles?\/|\/learn\/|\/guides?\//.test(u));
				const h = hosts.get(host)!;
				return {
					host,
					inCorpus: h.rows,
					bestRank: h.best === 999 ? null : h.best,
					sitemap: sm.status,
					// null, never 0, when the read told us nothing: a 404 or a 429 means we could not look,
					// which is not the same as a site that publishes nothing.
					urls: sm.status === 200 ? locs.length : null,
					posts: sm.status === 200 ? posts.length : null,
					...(nested ? { sitemaps: nested, read: Math.min(8, nested) } : {})
				};
			},
			{ limit: 5, label: "sitemap" }
		);
		return newest(scale, (s) => String(s.posts ?? 0).padStart(7, "0"), o.limit);
	}
};
