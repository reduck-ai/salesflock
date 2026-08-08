// geo tools — TWO LEVERS and the reads, over one intent table and three append-only logs.
//
//   ask     one draw: record the answer, then in the same act cross-validate every query it issued
//           on the index its web tool reads, and fetch every page it read or that ranked. THE daily
//           lever — running it measures the whole funnel for one prompt.
//   search  one query by hand — the investigation door. Authoring a query IS searching it.
//
// EVERY OBSERVATION ROW IS CREATED COMPLETE AND NEVER TOUCHED. There is no upsert on the logs, no
// patch, no body rewrite, no retry queue: a refused search is a Search row carrying the reason, a
// failed fetch is a look carrying its error, and the next run mints fresh rows instead of healing
// old ones. That is what makes every a-posteriori analysis a plain read — rank drift (Search rows
// grouped by Key), egress comparison (same Key, different Egress), content drift (looks grouped by
// URL), draw variance (Answers grouped by their Prompt).
//
// OBSERVATIONS NEVER RELATE TO OBSERVATIONS — joins are by VALUE + time, none stored:
//   "what did Claude search"     Searches where Conversation = the draw's
//   "what did Claude read"       looks where Conversation = the draw's
//   "what ranked, at the draw"   that Search row's body (minutes after Asked at)
//   "rank of a page"             its URL's position in the body's results — rank IS the index
//   "retrieved but skipped"      body URLs minus the read looks
//   "which query surfaced it"    look URL ∈ which Search body (derived; a web_fetch read ⇒ none)
//   "rank over time"             group Searches by Key      "content drift"  group looks by URL
//
// THE ONE RULE THE TABLES OBEY: columns are keys, moments and circumstances; the RAW OBSERVATION
// lives in the row's body (a Search's SERP as the script returned it, a look's visible page text);
// everything else — rank, mentions, verdicts, readable, currently-ranked — is DERIVED at read time
// under today's config, so widening BRAND re-reads the whole corpus with nothing to migrate.

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
import type { GEOSearches } from "./schema/GEOSearches.js";
import type { GEOResults } from "./schema/GEOResults.js";

const store = getStore(config.destination);
// The four tables, read at CALL time. A table id belongs to the installation (src/models.ts), so
// destructuring it here would read every id the moment this module is imported — and an unconfigured
// clone would then fail on `import` rather than inside the command, past the CLI's own error handler.
const T = config.models;

// ─── identity helpers ────────────────────────────────────────────────────────────────────────────

// A query in any shape — bare text, or a full `<engine>:<text>` key — to its normalized key. The
// value IS the identity (there is no queries table to look it up in), so every writer and every
// filter passes through this one normalizer.
const keyOf = (q: string): string => {
	if (q.includes(":")) {
		const { engine, query } = queryParts(q);
		if (ENGINES[engine as keyof typeof ENGINES]) return queryKey(engine, query);
	}
	return queryKey(engineOf(DEFAULT_PROVIDER), q);
};

// Ours, tolerant of a malformed URL: a source list is whatever the assistant reported, so one
// unparseable entry must not take down a whole verdict.
const ours = (url: string): boolean => {
	try {
		return hostIsOurs(url, BRAND.domain);
	} catch {
		return false;
	}
};

// A URL list, canonicalized where possible, deduped — the join key into the looks. An entry too
// malformed to canonicalize is logged and dropped: no look can exist for a page no client could ask for.
const canonSources = (urls: readonly string[], label: string): string[] => [
	...new Set(
		urls.flatMap((u) => {
			try {
				return [canonicalUrl(u)];
			} catch {
				log("read", `${label}: dropped unparseable URL ${JSON.stringify(u)}`);
				return [];
			}
		})
	)
];

const lines = (v: unknown): string[] =>
	String(v ?? "")
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);

// ─── the writes: one per log, each creating a row COMPLETE — the whole write discipline ─────────

const writePrompt = (prompt: string) => store.upsert(T.GEOPrompts, { Prompt: promptKey(prompt) }, "Prompt");

const writeAnswer = (fields: GEOAnswers) => store.create(T.GEOAnswers, fields);

// One query DONE: the row (moment + circumstances + whose), then the raw SERP into its body — once,
// ever. A rejected run has no SERP, so no body: "no body" cleanly means "execution known, SERP
// unobserved or refused", and the Error says which.
const writeSearch = async (
	key: string,
	searchedAt: string,
	o: { egress: string; conversation?: string; error?: string; raw?: Search }
) => {
	const ref = await store.create(T.GEOSearches, {
		Name: `${key.slice(0, 80)} — ${searchedAt.slice(0, 19).replace("T", " ")}`,
		Key: key,
		Engine: queryParts(key).engine as GEOSearches["Engine"],
		"Searched at": searchedAt,
		Egress: o.egress,
		...(o.conversation ? { Conversation: o.conversation } : {}),
		...(o.error ? { Error: o.error } : {})
	} satisfies GEOSearches);
	if (o.raw) await store.setBody(ref.id, JSON.stringify(o.raw, null, 1), "json");
	return ref;
};

// look(url, conversation?) — one page over plain HTTP, recorded as one row: fetch FIRST, then create
// the row complete, then its text into the body. No browser, because a crawler has none either: a
// page that only renders in one is a page a crawler cannot read, and that IS the finding.
// `conversation` set means the model read this page in that draw.
//
// A network-level failure (status 0) is still a complete observation — we looked, at this instant,
// and could not reach it — but it says nothing about whether a crawler can read the page, which is
// why `readable` derives to unknown for it rather than false.
const look = async (url: string, conversation?: string) => {
	const u = canonicalUrl(url);
	const t0 = Date.now();
	const got = await http.get(u);
	const httpMs = Date.now() - t0;
	const ref = await store.create(T.GEOResults, {
		URL: u,
		Status: got.status,
		"Text length": got.text.length,
		"Final URL": got.finalUrl,
		"Fetched at": new Date().toISOString(),
		...(got.error ? { Error: got.error } : {}),
		...(conversation ? { Conversation: conversation } : {})
	} satisfies GEOResults);
	// The body is the page's visible TEXT, not its markup: the prose is what a search engine indexes,
	// what an LLM reads, and what "what do the winners publish" means — while the markup around it is
	// 10–30× the bytes, every byte paid for again at Notion's ~2.5 rps on the way in.
	if (got.text) await store.setBody(ref.id, got.text, "plain text");
	log(
		"read",
		`${u.replace(/^https:\/\//, "")} → ${got.status || (got.error ?? "no response")} · ` +
			`${Math.round(got.text.length / 1000)}k chars · http ${(httpMs / 1000).toFixed(1)}s · ` +
			`store ${((Date.now() - t0 - httpMs) / 1000).toFixed(1)}s`
	);
	return {
		url: u,
		status: got.status,
		textLength: got.text.length,
		...(got.status ? { mentions: http.count(got.text, BRAND.aliases) } : { error: got.error ?? "no response" }),
		...(got.status && got.finalUrl !== u ? { finalUrl: got.finalUrl } : {})
	};
};

// fetchLooks(entries, label) — one look per URL, all now, each failure caught per page (logged and
// surfaced as data) so one dead host never takes down the run. The caller hands the deduped union of
// everything this run observed, with `conversation` set exactly on what the model read.
const fetchLooks = (entries: readonly { url: string; conversation?: string }[], label: string) =>
	mapLimit(
		[...entries],
		({ url, conversation }) =>
			look(url, conversation).catch((e: unknown) => {
				const error = renderError(e);
				log("read", `${url} → ${error}`);
				return { url, error };
			}),
		{ label }
	);

// WHERE a run went, as one short string on the Search row — `cloud/us-east-1`, `device:c12b4b27`.
// Derived from the target actually used rather than from config, so the record cannot disagree with
// where the browser was. A datacenter, a laptop and a residential proxy are three different
// measurements of Brave, and without this the observations are indistinguishable.
const egressOf = (opts: RunOpts): string => {
	const t = opts.target ?? "extension";
	const at = typeof t === "string" ? t : `device:${t.deviceId.slice(0, 8)}`;
	return `${at}${opts.country ? `/${opts.country}` : ""}${opts.region ? `/${opts.region}` : ""}`;
};

// ─── the search core, shared by both levers ──────────────────────────────────────────────────────

export interface SearchOutcome {
	key: string;
	raw?: Search; // absent when the run was refused
	relaxed?: boolean; // Brave dropped the operators — the SERP is not evidence about them
	error?: string;
}

// searchMany(keys, conversation?) — every query in ONE batched request (one reduck slot, one cloud
// browser per query, separate IPs — Brave's limiter is IP-keyed), one Search row per outcome. WIDTH
// FOLLOWS THE TARGET: all at once against the cloud; one at a time from a device (measured: six
// concurrent searches from one machine earned an HTTP 429 and a captcha that applied to ordinary
// browsing too).
//
// `operatorsApplied: false` is the one guard: Brave found too few documents matching the operator,
// dropped it, and answered a relaxed query over the whole web. Those hits are not evidence about the
// operator, so the caller must not fetch them as ranked — but the observation still lands in the
// body, and the REASON on the row's Error.
export const searchMany = async (queries: readonly string[], conversation?: string): Promise<SearchOutcome[]> => {
	if (!queries.length) return [];
	const keys = queries.map(keyOf);
	const target = ENGINES.brave.target as RunOpts;
	const egress = egressOf(target);
	const searchedAt = new Date().toISOString();

	const texts = keys.map((k) => queryParts(k).query);
	let settled: PromiseSettledResult<Search>[];
	if (typeof target.target === "string") settled = await searchAll(texts, target);
	else {
		settled = [];
		for (const t of texts) settled.push(...(await searchAll([t], target)));
	}

	return mapLimit(keys, async (key, i): Promise<SearchOutcome> => {
		const outcome = settled[i];
		if (outcome.status === "rejected") {
			const error = renderError(outcome.reason);
			await writeSearch(key, searchedAt, { egress, conversation, error }).catch((e: unknown) =>
				log("search", `${key} → row not written: ${renderError(e)}`)
			);
			log("search", `${key} → ${error}`);
			return { key, error };
		}
		const s = outcome.value;
		const relaxed = !s.operatorsApplied;
		await writeSearch(key, searchedAt, {
			egress,
			conversation,
			raw: s,
			...(relaxed ? { error: "Brave dropped the operators and answered a relaxed query — not evidence about them" } : {})
		});
		log(
			"search",
			`${key} → ${s.results.length} results @${egress}${conversation ? " (claude)" : ""}` +
				`${relaxed ? " (operators dropped — relaxed)" : ""}`
		);
		return { key, raw: s, ...(relaxed ? { relaxed: true } : {}) };
	});
};

// The URLs a set of outcomes RANKED — honoured SERPs only: a relaxed SERP stays in its body as an
// observation but ranks nothing.
const rankedUrls = (outcomes: readonly SearchOutcome[]): string[] =>
	canonSources(
		outcomes.flatMap((o) => (o.raw && !o.relaxed ? o.raw.results.map((r) => r.url) : [])),
		"serp"
	);

// ─── the verdicts — pure functions of what the logs hold, computed at read ──────────────────────

// The diagnosis for ONE draw. The order is the order of causes: a truncated answer is not a
// measurement at all, then "did it even search", then the three retrieval outcomes.
//
// `Truncated` is the invariant this repo states as "eliminate on evidence, never on absence": an
// answer cut off mid-stream may simply not have reached our name yet, so calling it `Not retrieved`
// would freeze a false negative. It is insufficient data, and it defers.
export type Verdict = "Truncated" | "No search" | "Not retrieved" | "Passed over" | "Cited";

export interface Draw {
	stopReason: string;
	searched: boolean; // a Search row with this draw's Conversation exists
	readUs: boolean; // a look with this draw's Conversation on one of our pages exists
	answer: string;
}

export const verdictOf = (d: Draw): Verdict => {
	if (d.stopReason !== "end_turn") return "Truncated";
	if (!d.searched) return "No search";
	// Word-boundary matched against every declared alias, so a short brand name cannot fire inside an
	// unrelated word.
	if (http.count(d.answer, BRAND.aliases) > 0) return "Cited";
	return d.readUs ? "Passed over" : "Not retrieved";
};

// Best across draws — how a PROMPT stands, given that its answers disagree. `Truncated` is absent
// from the ladder on purpose: it is not an outcome, so it neither wins nor counts.
const BEST: readonly Verdict[] = ["Cited", "Passed over", "Not retrieved", "No search"];

// The per-draw joins, computed once per read from whole tables: which Conversations searched, and
// which read one of our pages. Both are Sets over VALUES — no relation to follow, nothing stored.
const searchedConvs = (searches: Row[]): Set<string> =>
	new Set(searches.map((r) => String(r.fields.Conversation ?? "")).filter(Boolean));
const readUsConvs = (ourLooks: Row[]): Set<string> =>
	new Set(
		ourLooks
			.filter((r) => r.fields.Conversation && ours(String(r.fields.URL ?? "")))
			.map((r) => String(r.fields.Conversation))
	);

const drawView = (a: Row, searched: Set<string>, readUs: Set<string>): Verdict => {
	const conv = String(a.fields.Conversation ?? "");
	return verdictOf({
		stopReason: String(a.fields["Stop reason"] ?? ""),
		searched: searched.has(conv),
		readUs: readUs.has(conv),
		answer: String(a.fields.Answer ?? "")
	});
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

// One Search row's SERP, whole, as the script returned it. `null` for a row with no body — a refused
// run — which reads as "no SERP on record", never as an empty result.
const serpOf = async (searchRowId: string): Promise<Search | null> => {
	const body = unfence(await store.body(searchRowId)).trim();
	if (!body) return null;
	try {
		return JSON.parse(body) as Search;
	} catch {
		return null;
	}
};

// rank/title/snippet/age for every page a SERP ranked, keyed by canonical URL. Rank IS the index —
// the SERP is an ordered list, and that order is the whole fact. A relaxed SERP ranks nothing.
const rankedOf = (s: Search | null): Map<string, { rank: number; title: string; snippet: string | null; age: string | null }> => {
	const m = new Map<string, { rank: number; title: string; snippet: string | null; age: string | null }>();
	if (!s?.operatorsApplied) return m;
	for (const [i, r] of s.results.entries()) {
		try {
			const u = canonicalUrl(r.url);
			if (!m.has(u)) m.set(u, { rank: i + 1, title: r.title, snippet: r.snippet ?? null, age: r.age ?? null });
		} catch {
			// a URL too malformed to canonicalize stays in the body, unranked here
		}
	}
	return m;
};

// The newest HONOURED search per Key — what "currently ranked" means, derived. A refused or relaxed
// attempt never shadows the last good SERP: it carries an Error, so it is skipped here while staying
// a visible row in `searches get`.
const latestByKey = (searches: Row[]): Map<string, Row> => {
	const m = new Map<string, Row>();
	for (const r of searches) {
		if (r.fields.Error) continue;
		const k = String(r.fields.Key ?? "");
		if (!k) continue;
		const cur = m.get(k);
		if (!cur || String(r.fields["Searched at"] ?? "").localeCompare(String(cur.fields["Searched at"] ?? "")) > 0)
			m.set(k, r);
	}
	return m;
};

// How many times a body names us — under today's BRAND, at the moment somebody asks. The whole
// reason no `Mentions` column (and no stamp over it) exists. `textOf` is a no-op on the plain text
// looks store, kept for tolerance of anything older.
const mentionsOf = (body: string): number => http.count(http.textOf(body), BRAND.aliases);

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

// One look, as read off its row. Rank is NOT here, deliberately: rank is a fact about a (query,
// page) pair at one search, so it only exists in a reading that names the query — `results get
// --query` decorates from that SERP.
const MIN_TEXT = Number(process.env.GEO_MIN_TEXT) || 500;

export const lookView = (r: Row) => {
	const url = String(r.fields.URL ?? "");
	const status = Number(r.fields.Status ?? 0);
	const len = Number(r.fields["Text length"] ?? 0);
	return {
		url,
		kind: kindOf(url),
		ours: url ? ours(url) : false,
		fetchedAt: r.fields["Fetched at"] ?? null,
		finalUrl: r.fields["Final URL"] ?? null,
		// The model read this page, in that draw. Empty on a page that only ranked — which is what
		// makes "retrieved but skipped" a visible column instead of a reconstruction.
		read: !!r.fields.Conversation,
		conversation: r.fields.Conversation ?? null,
		error: r.fields.Error ?? null,
		status,
		textLength: len,
		// Status 0 ⇒ unknown, not false: a timeout or DNS blip is a fact about our attempt, not about
		// whether a crawler can read the page. The two negatives must not fuse.
		readable: status === 0 ? null : status >= 200 && status < 300 && len >= MIN_TEXT
	};
};

// ─── selecting: one vocabulary per log, compiled to store clauses ────────────────────────────────

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
export interface SearchSelect {
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
	source?: boolean; // only pages a model READ (Conversation set)
	ranked?: boolean; // only pages some Key's newest honoured SERP currently ranks
	history?: boolean; // every look, not just the newest per URL
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
const ALL_SEARCHES = { and: [all("Name")] };

// `limit` is deliberately absent from every filter: it trims the ANSWER, never the work, so it is a
// property of a reading and not a fact about the set.
const newest = <T>(rows: T[], key: (t: T) => string, limit?: number): T[] => {
	const sorted = [...rows].sort((a, b) => key(b).localeCompare(key(a)));
	return limit ? sorted.slice(0, limit) : sorted;
};

const promptFilter = (o: PromptSelect): object => ({
	and: [all("Prompt"), ...anyOf((o.prompt ?? []).map((p) => ({ property: "Prompt", title: { equals: promptKey(p) } })))]
});

const searchFilter = (o: SearchSelect): object => ({
	and: [
		all("Name"),
		...anyOf((o.query ?? []).map((q) => ({ property: "Key", rich_text: { equals: keyOf(q) } }))),
		...(o.engine ? [{ property: "Engine", select: { equals: o.engine.toLowerCase() } }] : [])
	]
});

const resultFilter = (o: ResultSelect): object => ({
	and: [
		all("URL"),
		...anyOf((o.url ?? []).map((u) => ({ property: "URL", title: { equals: canonicalUrl(u) } }))),
		// `contains` casts a slightly wide net (any URL carrying the domain as a substring); the
		// reader post-filters with `ours`, which is anchored on the host. The store clause is only
		// there to keep the read small.
		...(o.ours ? [{ property: "URL", title: { contains: BRAND.domain } }] : []),
		...(o.source ? [{ property: "Conversation", rich_text: { is_not_empty: true } }] : [])
	]
});

// The Search rows behind `--query`, loud when a value was never searched — a filter over a query
// nothing has done would read as an empty corpus.
const searchRowsOf = async (queries: readonly string[]): Promise<Row[]> => {
	const rows = await queryAll(store, T.GEOSearches, searchFilter({ query: [...queries] }));
	for (const q of queries)
		if (!rows.some((r) => String(r.fields.Key ?? "") === keyOf(q)))
			throw new Error(`no search of "${keyOf(q)}" — nothing has done it (run \`geo search\`)`);
	return rows;
};

// ─── the two levers ──────────────────────────────────────────────────────────────────────────────

// ask — one draw, then everything it implies, in one act. The draw is the expensive, unrepeatable
// part, so its record is written before anything else may fail; the cross-validation and the fetches
// only ever ADD rows, so a crash mid-run loses nothing already written and reconciles nothing.
export const ask = async (prompt: string, provider: string = DEFAULT_PROVIDER) => {
	const p = promptKey(prompt);
	const spec = PROVIDERS[provider as keyof typeof PROVIDERS];
	if (!spec) throw new Error(`no provider "${provider}" — declare it in agents/geo/config.ts`);
	const engine = engineOf(provider);

	const askedAt = new Date().toISOString();
	const a = await askAssistant(p, spec.target);
	const conversation = a.conversationId;
	const queries = a.webSearchQueries ?? [];
	const sources = (a.sources ?? []).map((s) => s.url).filter(Boolean);

	// The prompt row exists already on the normal path (`prompts add`), but a draw is also the moment
	// we learn a prompt is real — so this converges rather than assuming.
	const promptRef = await writePrompt(p);
	const ref = await writeAnswer({
		Name: `${p.slice(0, 60)} — ${provider} — ${askedAt.slice(0, 19).replace("T", " ")}`,
		Prompt: [promptRef.id],
		Provider: provider as GEOAnswers["Provider"],
		Model: spec.model,
		"Asked at": askedAt,
		Conversation: conversation,
		"Stop reason": a.stopReason ?? "",
		Answer: a.answer
	});

	// The cross-validation: every query Claude issued, run on the index its web tool reads, minutes
	// later — those SERPs are the record of what it searched (Claude's SERP IS Brave's SERP).
	const outcomes = await searchMany(queries.map((q) => queryKey(engine, q)), conversation);

	// ONE fetch pass over everything this draw observed: what the model READ (Conversation stamped)
	// ∪ what its queries RANKED — deduped by canonical URL, one look each.
	const read = new Set(canonSources(sources, p.slice(0, 32)));
	const urls = [...new Set([...read, ...rankedUrls(outcomes)])];
	const pages = await fetchLooks(
		urls.map((u) => ({ url: u, ...(read.has(u) ? { conversation } : {}) })),
		`read ${p.slice(0, 32)}`
	);

	const verdict = verdictOf({
		stopReason: a.stopReason ?? "",
		searched: queries.length > 0,
		readUs: sources.some(ours),
		answer: a.answer
	});
	log(
		"ask",
		`${p.slice(0, 48)} @${provider} → ${verdict} (${queries.length} queries, ${read.size} read, ` +
			`${pages.filter((r) => !("error" in r)).length}/${urls.length} looked)`
	);
	return {
		prompt: p,
		provider,
		verdict,
		queries,
		read: read.size,
		pages,
		answer: ref.url
	};
};

// ─── the tools ───────────────────────────────────────────────────────────────────────────────────

export const tools = {
	prompts: {
		add: async (texts: string[]) =>
			batch(texts, async (t) => {
				const r = await writePrompt(t);
				return { prompt: promptKey(t), created: r.created, url: r.url };
			}),

		// The scoreboard: one line per prompt, everything derived from the three logs in four reads —
		// answers grouped on the Prompt relation, verdicts from the Conversation joins.
		get: async (o: PromptSelect = {}) => {
			const [prompts, answers, searches, ourLooks] = await Promise.all([
				queryAll(store, T.GEOPrompts, promptFilter(o)),
				queryAll(store, T.GEOAnswers, ALL_ANSWERS),
				queryAll(store, T.GEOSearches, ALL_SEARCHES),
				queryAll(store, T.GEOResults, resultFilter({ ours: true, source: true }))
			]);
			const searched = searchedConvs(searches);
			const readUs = readUsConvs(ourLooks);
			const views = prompts.map((p) => {
				const mine = answers.filter((a) => (a.rel.Prompt ?? []).includes(p.id));
				const verdicts = mine.map((a) => drawView(a, searched, readUs));
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
			});
			const kept = o.verdict ? views.filter((v) => v.verdict === o.verdict) : views;
			return newest(kept, (v) => String(v.lastAsked ?? ""), o.limit);
		}
	},

	answers: {
		// One line per draw: verdict, the queries it issued (Search Keys sharing its Conversation),
		// whether it read us. The answer TEXT is `show`'s job — it is the biggest column in the schema.
		get: async (o: AnswerSelect = {}) => {
			const [rows, prompts, searches, ourLooks] = await Promise.all([
				queryAll(store, T.GEOAnswers, {
					and: [all("Name"), ...(o.provider ? [{ property: "Provider", select: { equals: o.provider } }] : [])]
				}),
				queryAll(store, T.GEOPrompts, promptFilter({ prompt: o.prompt })),
				queryAll(store, T.GEOSearches, ALL_SEARCHES),
				queryAll(store, T.GEOResults, resultFilter({ ours: true, source: true }))
			]);
			const wanted = new Set(prompts.map((p) => p.id));
			const promptText = new Map(prompts.map((p) => [p.id, String(p.fields.Prompt ?? "")]));
			const searched = searchedConvs(searches);
			const readUs = readUsConvs(ourLooks);
			const byConv = new Map<string, string[]>();
			for (const s of searches) {
				const conv = String(s.fields.Conversation ?? "");
				if (conv) (byConv.get(conv) ?? byConv.set(conv, []).get(conv)!).push(String(s.fields.Key ?? ""));
			}
			const views = rows
				.filter((r) => (r.rel.Prompt ?? []).some((id) => wanted.has(id)))
				.map((r) => {
					const conv = String(r.fields.Conversation ?? "");
					return {
						prompt: promptText.get((r.rel.Prompt ?? [])[0]) ?? null,
						provider: r.fields.Provider ?? null,
						model: r.fields.Model ?? null,
						askedAt: String(r.fields["Asked at"] ?? ""),
						verdict: drawView(r, searched, readUs),
						queries: byConv.get(conv) ?? [],
						readUs: readUs.has(conv),
						conversation: r.fields.Conversation ?? null
					};
				});
			const kept = o.verdict ? views.filter((v) => v.verdict === o.verdict) : views;
			return newest(kept, (v) => v.askedAt, o.limit);
		},

		// One draw in full — the answer text, its queries, and what it READ (the looks sharing its
		// Conversation) — which is what you read when the verdict says `Passed over` and you want to
		// know what it said instead. Newest first; defaults to 1.
		show: async (o: AnswerSelect = {}) => {
			const [rows, prompts, searches] = await Promise.all([
				queryAll(store, T.GEOAnswers, ALL_ANSWERS),
				queryAll(store, T.GEOPrompts, promptFilter({ prompt: o.prompt })),
				queryAll(store, T.GEOSearches, ALL_SEARCHES)
			]);
			const wanted = new Set(prompts.map((p) => p.id));
			const promptText = new Map(prompts.map((p) => [p.id, String(p.fields.Prompt ?? "")]));
			const byConv = new Map<string, string[]>();
			for (const s of searches) {
				const conv = String(s.fields.Conversation ?? "");
				if (conv) (byConv.get(conv) ?? byConv.set(conv, []).get(conv)!).push(String(s.fields.Key ?? ""));
			}
			const shown = newest(
				rows.filter((r) => (r.rel.Prompt ?? []).some((id) => wanted.has(id))),
				(r) => String(r.fields["Asked at"] ?? ""),
				o.limit ?? 1
			);
			return mapLimit(shown, async (r) => {
				const conv = String(r.fields.Conversation ?? "");
				// The read pool, by the value join — one targeted query per shown draw.
				const reads = conv
					? await queryAll(store, T.GEOResults, { and: [{ property: "Conversation", rich_text: { equals: conv } }] })
					: [];
				const readUrls = reads.map((l) => String(l.fields.URL ?? ""));
				return {
					prompt: promptText.get((r.rel.Prompt ?? [])[0]) ?? null,
					provider: r.fields.Provider ?? null,
					askedAt: r.fields["Asked at"] ?? null,
					stopReason: r.fields["Stop reason"] ?? null,
					verdict: verdictOf({
						stopReason: String(r.fields["Stop reason"] ?? ""),
						searched: (byConv.get(conv) ?? []).length > 0,
						readUs: readUrls.some(ours),
						answer: String(r.fields.Answer ?? "")
					}),
					queries: byConv.get(conv) ?? [],
					read: readUrls,
					answer: String(r.fields.Answer ?? "")
				};
			});
		}
	},

	searches: {
		// The SERP time series: one line per query DONE — whose it was (claude/direct), from where,
		// what it returned. Ranked counts come from each row's body, so they are read only for the
		// rows this reading keeps (bounded by --limit).
		get: async (o: SearchSelect = {}) => {
			const rows = newest(
				await queryAll(store, T.GEOSearches, searchFilter(o)),
				(r) => String(r.fields["Searched at"] ?? ""),
				o.limit
			);
			return mapLimit(rows, async (r) => {
				const serp = await serpOf(r.id);
				return {
					key: String(r.fields.Key ?? ""),
					engine: r.fields.Engine ?? null,
					searchedAt: r.fields["Searched at"] ?? null,
					egress: r.fields.Egress ?? null,
					trigger: r.fields.Conversation ? "claude" : "direct",
					conversation: r.fields.Conversation ?? null,
					results: serp ? serp.results.length : null,
					error: r.fields.Error ?? null
				};
			});
		}
	},

	results: {
		// One line per PAGE by default (the newest look of each URL — the corpus view); --history
		// keeps every look. Rank appears only when `--query` names whose ranking you are asking about,
		// read out of that query's newest honoured SERP; `--mentions` counts each candidate's stored
		// body under today's BRAND — a body read per row, the one filter that costs more than a query.
		get: async (o: ResultSelect = {}) => {
			const rows = await queryAll(store, T.GEOResults, resultFilter(o));
			let views = rows.map(lookView);
			if (!o.history) {
				const seen = new Map<string, (typeof views)[number]>();
				for (const v of newest(views, (x) => String(x.fetchedAt ?? ""))) if (!seen.has(v.url)) seen.set(v.url, v);
				views = [...seen.values()];
			}
			if (o.ours) views = views.filter((v) => v.ours);
			if (o.unreadable) views = views.filter((v) => v.readable === false);

			// The named queries' newest honoured SERPs — for the rank decoration and the membership
			// filter. One body read per query, not per page.
			if (o.query?.length) {
				const latest = latestByKey(await searchRowsOf(o.query));
				const serps = await mapLimit([...latest.values()], (r) => serpOf(r.id));
				const ranked = serps.map(rankedOf);
				views = views.flatMap((v) => {
					const hit = ranked.map((m) => m.get(v.url)).find(Boolean);
					return hit ? [{ ...v, ...hit }] : [];
				});
			} else if (o.ranked) {
				// Membership in ANY key's current SERP — every newest honoured body, read once each.
				const latest = latestByKey(await queryAll(store, T.GEOSearches, ALL_SEARCHES));
				const serps = await mapLimit([...latest.values()], (r) => serpOf(r.id));
				const current = new Set(serps.flatMap((s) => [...rankedOf(s).keys()]));
				views = views.filter((v) => current.has(v.url));
			}

			// Mentions, computed last so the bodies read are only the survivors'.
			if (o.mentions) {
				const byId = new Map(rows.map((r) => [`${r.fields.URL}::${r.fields["Fetched at"]}`, r.id]));
				const withMentions = await mapLimit(views, async (v) => {
					const id = byId.get(`${v.url}::${v.fetchedAt}`);
					const mentions = id && v.textLength ? mentionsOf(unfence(await store.body(id))) : 0;
					return { ...v, mentions };
				});
				views = withMentions.filter((v) => (v as { mentions: number }).mentions > 0);
			}
			return newest(views, (v) => String(v.fetchedAt ?? ""), o.limit);
		},

		// show — one PAGE across time: every look of it newest-first, the newest body in full (its
		// mention count under today's BRAND), the older looks as their columns — which is what makes
		// content drift a read. A refused page still tells its story: `status: 403` with a few hundred
		// chars is a bot wall, a 200 with almost no text is a client-rendered shell.
		show: async (url: string) => {
			const u = canonicalUrl(url);
			const rows = newest(
				await queryAll(store, T.GEOResults, { and: [{ property: "URL", title: { equals: u } }] }),
				(r) => String(r.fields["Fetched at"] ?? "")
			);
			if (!rows.length) throw new Error(`no look at ${u} — nothing has fetched it`);
			const withBody = rows.find((r) => Number(r.fields["Text length"] ?? 0) > 0);
			const text = withBody ? unfence(await store.body(withBody.id)) : null;
			return {
				...lookView(rows[0]),
				looks: rows.map((r) => ({
					fetchedAt: r.fields["Fetched at"] ?? null,
					status: Number(r.fields.Status ?? 0),
					textLength: Number(r.fields["Text length"] ?? 0),
					read: !!r.fields.Conversation,
					error: r.fields.Error ?? null
				})),
				mentions: text ? mentionsOf(text) : null,
				text
			};
		}
	},

	// THE FIRST LEVER — and the daily one. Ask the prompts you name — or every prompt in the panel —
	// one new draw each: the answer recorded, its queries cross-validated, everything it saw fetched.
	// No counting, no threshold: running it IS the decision to measure. Want another draw? Run it again.
	ask: async (texts?: readonly string[], provider: string = DEFAULT_PROVIDER) => {
		const targets = texts?.length
			? texts.map(promptKey)
			: (await queryAll(store, T.GEOPrompts, { and: [all("Prompt")] })).map((p) => String(p.fields.Prompt ?? ""));
		return batch(targets, (p) => ask(p, provider), "ask");
	},

	// THE SECOND LEVER — the investigation door. Search the queries you name (authoring IS searching;
	// there is no add step), or with nothing named re-audit every Key ever done. Each run appends a
	// Search row and a look per ranked page; nothing is ever overwritten.
	search: async (texts?: readonly string[]) => {
		const keys = texts?.length
			? texts.map(keyOf)
			: [
					...new Set(
						(await queryAll(store, T.GEOSearches, ALL_SEARCHES)).map((r) => String(r.fields.Key ?? "")).filter(Boolean)
					)
				];
		if (!keys.length) return [];
		const outcomes = await searchMany(keys);
		const pages = await fetchLooks(
			rankedUrls(outcomes).map((url) => ({ url })),
			"read serp"
		);
		return outcomes.map((o) => ({
			query: o.key,
			...(o.raw ? { results: o.raw.results.length } : {}),
			...(o.relaxed ? { relaxed: true } : {}),
			...(o.error ? { error: o.error } : {}),
			fetched: pages.filter((p) => !("error" in p)).length
		}));
	},

	// domains — how much each domain in the corpus PUBLISHES, which is the dimension that separated the
	// winners once anything else stopped predicting rank. The corpus is the current SERPs (who ranks,
	// how well — the newest honoured body per Key); the scale is each site's own sitemap, computed on
	// demand and stored NOWHERE: it is a fact about a domain rather than about any row we hold, and it
	// changes on its own schedule.
	domains: async (o: ResultSelect = {}) => {
		const rows = o.query?.length ? await searchRowsOf(o.query) : await queryAll(store, T.GEOSearches, ALL_SEARCHES);
		const serps = await mapLimit([...latestByKey(rows).values()], (r) => serpOf(r.id));
		const hosts = new Map<string, { ranked: number; best: number }>();
		for (const s of serps)
			for (const [url, { rank }] of rankedOf(s)) {
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
