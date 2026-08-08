// geo tools — TWO LEVERS and the reads. No status logic anywhere: a lever does its thing to what
// you name (default: everything in its table), records what it saw, and fetches those pages in the
// same run. Running a lever IS the decision; run it again to measure again.
//
//   ask     one assistant, one prompt, one draw → an Answer row (the answer, the sources it read),
//           a Query row per reformulation — and every source page fetched on the spot.
//   search  one query on its engine → the SERP lands whole in the query's own body, one Result row
//           per ranked page — and every ranked page fetched on the spot.
//
// There is no third stage and no retry queue. A fetch that fails writes its reason on the row and
// stamps nothing — truthful — and heals the next time any run observes that page, because a run
// always fetches what it observes.
//
// THE ONE RULE THE TABLES OBEY: columns are keys, cursors and relations; the RAW OBSERVATION lives
// in the row's body; everything else is DERIVED at read time.
//
//   a Query's body    the latest search, whole: `{searchedAt, egress, search}` where `search` is the
//                     script's own output. Rank IS the index — so rank, title, snippet and age are
//                     read out of the SERP, never stored as columns that could outlive it.
//   a Result's body   the page as served (raw HTML). A Result row is ONE PAGE — keyed on the
//                     canonical URL, however we came to look at it — so a page three queries rank
//                     and two draws read is one row, one fetch, one body. Mentions are counted off
//                     this body under today's BRAND, which is why no count is stored and no stamp
//                     is needed: widening an alias re-counts the corpus on the next read.
//
// THE TABLES ARE JOINED BY NOTION RELATIONS, each written from the side whose list is COMPLETE the
// moment it is written:
//
//   Answer.Prompt    → one prompt                      ⇒ Prompt.Answers fills itself
//   Answer.Queries   → that draw's whole reformulation set, known at write time
//   Query.Results    → the SERP's page set, known at search time — REPLACED on re-search, so the
//                      relation always reads "currently ranked" (the superseded SERP is only ever
//                      in the body it came from) ⇒ Result.Query fills itself
//
// Answers do NOT relate to Results: a source list is the assistant's own report (the `Sources` text,
// verbatim), and the join to what we fetched is the canonical URL itself — a key, not a relation.

import { getStore, queryAll } from "../../src/stores/index.js";
import type { Row } from "../../src/stores/index.js";
import { mapLimit, batch } from "../../src/concurrency.js";
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
import type { RunOpts } from "../../src/clients/reduck.js";
import type { Search } from "../../src/clients/geo/schema.js";
import config, { BRAND, DEFAULT_PROVIDER, ENGINES, PROVIDERS, engineOf } from "./config.js";
import type { GEOAnswers } from "./schema/GEOAnswers.js";
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

const writePrompt = (prompt: string) => store.upsert(T.GEOPrompts, { Prompt: promptKey(prompt) }, "Prompt");

// An answer is CREATED, never upserted: it accumulates. Three draws of one prompt are three rows,
// because the assistant answers differently each time and that variance IS the measurement. It also
// needs no identity column at all — nothing ever looks one up by key.
const writeAnswer = (fields: GEOAnswers) => store.create(T.GEOAnswers, fields);

const writeQuery = (key: string, fields: Omit<Partial<GEOQueries>, "Key"> = {}) =>
	store.upsert(T.GEOQueries, { ...fields, Key: key }, "Key");

// A result is ONE PAGE, converging on its canonical URL — which is the row's title, so there is no
// second Name to invent and nothing to drift. Upserted from every door in (a SERP hit, an
// assistant's source, a by-hand read), so however many ways we meet a page it is one row.
const writeResult = (url: string, fields: Omit<Partial<GEOResults>, "URL"> = {}) =>
	store.upsert(T.GEOResults, { ...fields, URL: canonicalUrl(url) }, "URL");

// WHERE a run went, as one short string inside the SERP envelope — `cloud/us-east-1`,
// `device:c12b4b27`. Derived from the target actually used rather than from config, so the record
// cannot disagree with where the browser was. A residential proxy, a datacenter and a laptop are
// three different measurements of Brave, and without this the observations are indistinguishable.
const egressOf = (opts: RunOpts): string => {
	const t = opts.target ?? "extension";
	const at = typeof t === "string" ? t : `device:${t.deviceId.slice(0, 8)}`;
	return `${at}${opts.country ? `/${opts.country}` : ""}${opts.region ? `/${opts.region}` : ""}`;
};

// ─── the raw observations, back out of the bodies ────────────────────────────────────────────────

// The body back out of the store, without the code fence. `store.body` renders a page as MARKDOWN,
// so the blocks `setBody` wrote come back wrapped in a fence — the store's rendering of what it
// holds, not a thing the content contains. Three exact edits rather than a fence parser: the opening
// fence, the closing one, and the seam between two consecutive blocks (content past ~200k chars
// spans several). Anything else that looks like a fence is the content's own and is left alone.
const unfence = (markdown: string): string =>
	markdown
		.replace(/^```\w*\n/, "")
		.replace(/\n```$/, "")
		.replace(/\n```\n\n```\w*\n/g, "");

// What one search observed, whole — the query's body. `null` for a query never searched (no body to
// read) and for a pre-envelope row, which reads as "no SERP on record" rather than an error: the
// column cursor (`Searched at`) is still what says whether a search still needs to run.
export interface SerpEnvelope {
	searchedAt: string;
	egress: string;
	search: Search;
}
const serpOf = async (queryRowId: string): Promise<SerpEnvelope | null> => {
	const body = unfence(await store.body(queryRowId)).trim();
	if (!body) return null;
	try {
		return JSON.parse(body) as SerpEnvelope;
	} catch {
		return null;
	}
};

// rank/title/snippet/age for every page a SERP ranked, keyed by canonical URL. Rank IS the index —
// the SERP is an ordered list, and that order is the whole fact.
const rankedOf = (env: SerpEnvelope | null): Map<string, { rank: number; title: string; snippet: string | null; age: string | null }> => {
	const m = new Map<string, { rank: number; title: string; snippet: string | null; age: string | null }>();
	for (const [i, r] of (env?.search.results ?? []).entries()) {
		try {
			const u = canonicalUrl(r.url);
			if (!m.has(u)) m.set(u, { rank: i + 1, title: r.title, snippet: r.snippet ?? null, age: r.age ?? null });
		} catch {
			// a URL too malformed to canonicalize stays in the body, unranked here
		}
	}
	return m;
};

// How many times the page names us — counted off the STORED body, under today's BRAND, at the
// moment somebody asks. The whole reason no `Mentions` column (and no stamp over it) exists.
const mentionsOf = (html: string): number => http.count(http.textOf(html), BRAND.aliases);

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

// A source list, canonicalized where possible — the join key into the Results table. An entry too
// malformed to canonicalize is dropped here and survives verbatim in the `Sources` text.
const canonSources = (sources: string[]): string[] => [
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

// A fetched result, as read: `readable` needs BOTH halves and that is the whole reason `Status` and
// `Text length` are separate columns — a 403 is bot protection (nothing you write helps) and a 200
// with no text is a client-rendered shell (server-render it), and the two need opposite work.
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

// One page, as read off its row. Rank is NOT here, deliberately: rank is a fact about a (query,
// page) pair at the query's latest search, so it only exists in a reading that names the query —
// `results get --query` decorates from that SERP. A bare rank column was ambiguous the moment a
// page ranked for two queries.
export const resultView = (r: Row, qKey: (id: string) => string = () => "") => {
	const url = String(r.fields.URL ?? "");
	const status = Number(r.fields.Status ?? 0);
	const len = Number(r.fields["Text length"] ?? 0);
	const fetched = !!r.fields["Fetched at"];
	return {
		url,
		// Every query currently ranking this page, through the relation.
		queries: (r.rel.Query ?? []).map(qKey).filter(Boolean),
		kind: kindOf(url),
		ours: url ? ours(url) : false,
		fetchedAt: r.fields["Fetched at"] ?? null,
		finalUrl: r.fields["Final URL"] ?? null,
		error: r.fields.Error ?? null,
		status: fetched ? status : null,
		textLength: fetched ? len : null,
		// Unfetched ⇒ unknown, not false. The two negatives must not fuse: "we looked and it is a
		// shell" and "we never looked" are different facts, and only one of them is evidence.
		readable: fetched ? status >= 200 && status < 300 && len >= MIN_TEXT : null
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
	source?: boolean; // only pages an assistant READ (derived from the answers' source lists)
	ranked?: boolean; // only pages some query currently ranks
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
const ALL_RESULTS = { and: [all("URL")] };

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

// Resolve `--query` to its row (the SERP holder and the relation anchor). Loud when nothing has
// searched it — a filter over a query that does not exist would read as an empty corpus.
const queryRowsOf = async (names: readonly string[]): Promise<Row[]> => {
	const rows: Row[] = [];
	for (const q of names) {
		const [row] = await store.query(T.GEOQueries, { property: "Key", title: { equals: normQuery(q) } });
		if (!row) throw new Error(`no query "${normQuery(q)}" — nothing has searched it`);
		rows.push(row);
	}
	return rows;
};

const resultFilter = (o: ResultSelect, queryIds: string[]): object => ({
	and: [
		all("URL"),
		...anyOf(queryIds.map((id) => ({ property: "Query", relation: { contains: id } }))),
		...anyOf((o.url ?? []).map((u) => ({ property: "URL", title: { equals: canonicalUrl(u) } }))),
		// `contains` casts a slightly wide net (any URL carrying the domain as a substring); the
		// reader post-filters with `ours`, which is anchored on the host. The store clause is only
		// there to keep the read small.
		...(o.ours ? [{ property: "URL", title: { contains: BRAND.domain } }] : []),
		...(o.ranked ? [{ property: "Query", relation: { is_not_empty: true } }] : [])
	]
});

// ─── the fetch: one page over plain HTTP, shared by both levers ──────────────────────────────────

// readPage — one page over plain HTTP: can a crawler read it, and what does it actually say. No
// browser, because a crawler has none either: a page that only renders in one is a page a crawler
// cannot read, and that IS the finding.
//
// THE ORDER IS THE SAFETY PROPERTY: body FIRST, columns (with `Fetched at`) LAST. `Fetched at` says
// "this row's body is the page as of this instant", so it must be the final thing that can fail — a
// body write that 413s then leaves the row saying what it truthfully is (last successful fetch, or
// never fetched), instead of a row stamped fetched with no page behind it (measured: exactly that
// happened before the order was fixed).
//
// A NETWORK-level failure is not an answer ABOUT the page. A timeout, a DNS blip or a dead socket
// says nothing about whether a crawler can read it — so only the `Error` lands (why the last try
// failed) and nothing else moves. An HTTP status — 403, 404, 500 — IS the server's answer, so it
// lands and stamps. Nothing schedules a retry: the next run that observes this page fetches it again.
export const readPage = async (id: string, url: string) => {
	if (!url) throw new Error(`result ${id} has no URL`);
	const got = await http.get(url);
	if (!got.status) {
		await store.patch(T.GEOResults, id, { Error: got.error ?? "no response" });
		return { url, status: 0, error: got.error ?? "no response" };
	}
	await store.setBody(id, got.html, "html");
	await store.patch(T.GEOResults, id, {
		Status: got.status,
		"Text length": got.text.length,
		// Where the redirects ended — a soft-404 landing on the homepage is only visible here.
		"Final URL": got.finalUrl,
		Error: "",
		"Fetched at": new Date().toISOString()
	});
	return {
		url,
		status: got.status,
		textLength: got.text.length,
		htmlLength: got.html.length,
		mentions: mentionsOf(got.html),
		...(got.finalUrl !== url ? { finalUrl: got.finalUrl } : {})
	};
};

// fetchPages(urls, label) — one row per canonical URL (upserted, so a page every run keeps meeting
// stays one row), then fetch EVERY one of them, now. No filter: a run fetches what it observed, so
// the stored body is the page as it stood at the observation — and a page whose last fetch failed
// heals here without anything having scheduled it. A failure is caught per page (logged, its reason
// patched onto the row) so one dead host never takes down the run. Each entry carries its row `id`,
// because the caller that just observed these pages is about to relate to them (search's SERP set).
const fetchPages = (urls: readonly string[], label: string) =>
	mapLimit(
		[...urls],
		async (u) => {
			const ref = await writeResult(u);
			return readPage(ref.id, canonicalUrl(u))
				.then((page) => ({ id: ref.id, ...page }))
				.catch(async (e: unknown) => {
					const error = renderError(e);
					log("read", `${u} → ${error}`);
					await store.patch(T.GEOResults, ref.id, { Error: error }).catch(() => undefined);
					return { id: ref.id, url: u, error };
				});
		},
		{ label }
	);

// ─── the two levers ──────────────────────────────────────────────────────────────────────────────

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
		// The list the script REPORTED, verbatim — the raw observation. What we fetched of it lives in
		// the Results table, joined by canonical URL; an entry too malformed to canonicalize survives
		// only here, which is why the column is kept. It is also what lets `verdictOf` stay a pure
		// function of one row: "did it read us" is answered fresh under today's BRAND, off this text.
		Sources: sources.join("\n")
	};
	const ref = await writeAnswer(fields);

	// …and now LOOK at what it read, in the same motion. A source is a page that provably reached the
	// model, so "what did it answer" and "what was it looking at" are one question.
	//
	// AFTER the answer is written, deliberately: the ask is the expensive, unrepeatable part (a draw
	// is a draw — the same prompt answers differently next time), so nothing that can fail is allowed
	// to stand between it and its record. A fetch that fails records its reason on the row and the
	// next run that observes the page fetches it again — no draw lost to a dead socket.
	const canon = canonSources(sources);
	const read = await fetchPages(canon, `read sources for ${p.slice(0, 32)}`);

	const verdict = verdictOf({ stopReason: a.stopReason ?? "", queries: queries.length, sources, answer: a.answer });
	log(
		"ask",
		`${p.slice(0, 48)} @${provider} → ${verdict} (${queries.length} queries, ${sources.length} sources, ` +
			`${read.filter((r) => !("error" in (r as object))).length}/${canon.length} read)`
	);
	return {
		prompt: p,
		provider,
		verdict,
		queries,
		sources: sources.length,
		pages: read,
		answer: ref.url
	};
};

// search — one query on its engine. The SERP lands WHOLE in the query's own body (the raw
// observation, egress and instant included), the ranked pages become Result rows (converged on URL),
// and the relation is replaced so it always reads "currently ranked". Then the new pages are
// fetched, in the same motion.
//
// `operatorsApplied: false` is the one guard: Brave found too few documents matching the operator,
// dropped it, and answered a relaxed query over the whole web. Those hits are not evidence about the
// operator, so none are recorded as ranked — but the observation still lands in the body, and the
// REASON on the query's `Error`. Recording nothing made "Brave refused the operator" and "nothing
// matched" and "never tried" the same row.
export const searchQueries = async (rows: Row[], target: RunOpts = ENGINES.brave.target) => {
	if (!rows.length) return [];
	const keys = rows.map((r) => String(r.fields.Key));
	const searchedAt = new Date().toISOString();
	const egress = egressOf(target);
	const outcomes = await searchAll(keys.map((k) => queryParts(k).query), target);
	return mapLimit(rows, async (row, i) => {
		const key = keys[i];
		const outcome = outcomes[i];
		if (outcome.status === "rejected") {
			// The failure is a fact about this attempt, so it lands on the row — truthfully: `Searched at`
			// keeps whatever the last SUCCESSFUL search stamped, and `Error` says why this try failed.
			const error = renderError(outcome.reason);
			await writeQuery(key, { Error: error }).catch(() => undefined);
			return { query: key, error };
		}
		const s = outcome.value;
		const relaxed = !s.operatorsApplied;
		const hits = relaxed ? [] : s.results;
		const urls = canonSources(hits.map((r) => r.url));

		// The SERP whole into the query's body (the observation), then its pages fetched now, then the
		// stamp and the relation last — so a query is never marked searched without its SERP on record,
		// and the relation is written from the ids the fetch just handed back.
		await store.setBody(row.id, JSON.stringify({ searchedAt, egress, search: s } satisfies SerpEnvelope, null, 1), "json");
		const read = await fetchPages(urls, `read ${key.slice(0, 32)}`);
		await writeQuery(key, {
			"Searched at": searchedAt,
			Error: relaxed ? "Brave dropped the operators and answered a relaxed query — no results recorded" : "",
			// REPLACED, not appended: the relation means "currently ranked", and the superseded SERP is
			// in the body it came from.
			Results: read.map((r) => r.id)
		});
		const fetched = read.filter((r) => !("error" in r)).length;
		log(
			"search",
			`${key} → ${hits.length} results, ${fetched}/${urls.length} fetched @${egress}` +
				`${relaxed ? " (operators dropped — relaxed query, not recorded)" : ""}`
		);
		return { query: key, results: hits.length, fetched, egress, ...(relaxed ? { relaxed: true } : {}) };
	});
};

// ─── the tools ───────────────────────────────────────────────────────────────────────────────────

// id → the query's readable key, for the readers that print a result's queries. Built from a table
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
		// column: a harvested query is one some answer points at, which the relation says outright.
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
					source: (r.rel.Answers ?? []).length ? "harvested" : "authored",
					draws: (r.rel.Answers ?? []).length,
					searchedAt: r.fields["Searched at"] ?? null,
					// Currently ranked pages — the relation the last search replaced. The SERP itself, with
					// ranks, is the row's body (`results get --query` reads it out).
					ranked: (r.rel.Results ?? []).length,
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
		// One line per PAGE. Rank appears only when `--query` names whose ranking you are asking about
		// (it is a fact about the pair, read out of that query's SERP body); `--mentions` counts each
		// candidate's stored body under today's BRAND — a body read per row, so it is the one filter
		// that costs more than a query.
		get: async (o: ResultSelect = {}) => {
			const namedQueries = await queryRowsOf(o.query ?? []);
			const [rows, queries] = await Promise.all([
				queryAll(store, T.GEOResults, resultFilter(o, namedQueries.map((r) => r.id))),
				queryAll(store, T.GEOQueries, ALL_QUERIES)
			]);
			const qKey = keyById(queries);

			// The named queries' SERPs, for the rank decoration — one body read per query, not per page.
			const serps = await mapLimit(namedQueries, (r) => serpOf(r.id));
			const ranked = serps.map(rankedOf);

			// The read-set join, only when asked: which pages some draw's tools actually read.
			const sourceSet = o.source
				? new Set(
						(await queryAll(store, T.GEOAnswers, ALL_ANSWERS)).flatMap((a) => canonSources(lines(a.fields.Sources)))
					)
				: undefined;

			let views = rows.map((r) => {
				const v = resultView(r, qKey);
				const hit = ranked.map((m) => m.get(v.url)).find(Boolean);
				return hit ? { ...v, ...hit } : v;
			});
			if (o.ours) views = views.filter((v) => v.ours);
			if (sourceSet) views = views.filter((v) => sourceSet.has(v.url));
			if (o.unreadable) views = views.filter((v) => v.readable === false);

			// Mentions, computed last so the bodies read are only the survivors'.
			if (o.mentions) {
				const withMentions = await mapLimit(views, async (v) => {
					const row = rows.find((r) => String(r.fields.URL) === v.url)!;
					const mentions = row.fields["Fetched at"] ? mentionsOf(unfence(await store.body(row.id))) : 0;
					return { ...v, mentions };
				});
				views = withMentions.filter((v) => (v as { mentions: number }).mentions > 0);
			}
			return newest(views, (v) => String(v.fetchedAt ?? ""), o.limit);
		},

		// show — one page in full: its row, its mention count under today's BRAND, and the stored BODY
		// — what we actually captured, as served. The reason the body is worth storing at all: a status
		// says a crawler was refused, the markup says whether it was a bot wall, a soft 404 or an empty
		// JavaScript shell.
		show: async (url: string) => {
			const [rows, queries] = await Promise.all([
				queryAll(store, T.GEOResults, { and: [{ property: "URL", title: { equals: canonicalUrl(url) } }] }),
				queryAll(store, T.GEOQueries, ALL_QUERIES)
			]);
			const row = rows[0];
			if (!row) throw new Error(`no page ${canonicalUrl(url)} — nothing has looked at it`);
			const html = row.fields["Fetched at"] ? unfence(await store.body(row.id)) : null;
			return {
				...resultView(row, keyById(queries)),
				mentions: html ? mentionsOf(html) : null,
				html
			};
		}
	},

	// THE FIRST LEVER. Ask the prompts you name — or every prompt in the table — one new draw each.
	// No counting, no threshold: running it IS the decision to measure, and its cost is exactly the
	// list it prints as it goes. Want another draw? Run it again.
	ask: async (texts?: readonly string[], provider: string = DEFAULT_PROVIDER) => {
		const targets = texts?.length
			? texts.map(promptKey)
			: (await queryAll(store, T.GEOPrompts, { and: [all("Prompt")] })).map((p) => String(p.fields.Prompt ?? ""));
		return batch(targets, (p) => ask(p, provider), "ask");
	},

	// THE SECOND LEVER. Search the queries you name — or every query in the table — a fresh SERP
	// each, replacing the last one in the row's body. WIDTH FOLLOWS THE TARGET: one at a time from a
	// device (measured: six concurrent searches from this machine earned an HTTP 429 and a captcha
	// from Brave that applied to ordinary browsing too), all at once against the cloud, where every
	// script gets its own browser and its own address.
	search: async (texts?: readonly string[]) => {
		const target = ENGINES.brave.target as RunOpts;
		const rows = texts?.length ? await queryRowsOf(texts) : await queryAll(store, T.GEOQueries, ALL_QUERIES);
		if (typeof target.target === "string") return searchQueries(rows, target);
		const out = [];
		for (const row of rows) out.push(...(await searchQueries([row], target)));
		return out;
	},

	// domains — how much each domain in the corpus PUBLISHES, which is the dimension that separated the
	// winners once anything else stopped predicting rank. The corpus is the SERPs (who ranks, how well);
	// the scale is each site's own sitemap, computed on demand and stored NOWHERE: it is a fact about a
	// domain rather than about any row we hold, and it changes on its own schedule.
	domains: async (o: ResultSelect = {}) => {
		const rows = o.query?.length ? await queryRowsOf(o.query) : await queryAll(store, T.GEOQueries, ALL_QUERIES);
		const serps = await mapLimit(rows, (r) => serpOf(r.id));
		const hosts = new Map<string, { ranked: number; best: number }>();
		for (const env of serps)
			for (const [url, { rank }] of rankedOf(env)) {
				let host: string;
				try {
					host = new URL(url).hostname.replace(/^www\./, "");
				} catch {
					continue;
				}
				const cur = hosts.get(host) ?? { ranked: 0, best: 999 };
				hosts.set(host, { ranked: cur.ranked + 1, best: Math.min(cur.best, rank) });
			}
		const wanted = o.ours ? [...hosts.keys()].filter((h) => h === BRAND.domain || h.endsWith(`.${BRAND.domain}`)) : [...hosts.keys()];
		const scale = await mapLimit(
			wanted,
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
					ranked: h.ranked,
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
