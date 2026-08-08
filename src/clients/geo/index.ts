// The AI-search client — a thin typed wrapper over the two base scripts the funnel calls, plus the
// three identity primitives every stored row keys on (the `threadUrl` twins).
//
// Two hosts, one client, because they are the two halves of one question: an assistant answers, and
// the index behind its web tool decides what it COULD have answered from. Which engine belongs to
// which assistant is the agent's declaration (config.ts PROVIDERS), never this file's — core carries
// the pair, it does not choose it.

import { run, runAll, type RunOpts } from "../reduck.js";
import { scripts } from "./scripts.js";
import type { Ask, Search, Submit } from "./schema.js";

export type { Ask, Search, Submit };

// ─── identity ────────────────────────────────────────────────────────────────────────────────────

// A prompt's key: the question itself, whitespace collapsed. CASE IS PRESERVED, deliberately and
// against the habit of every other key in this repo — the skill's central measured finding is that
// the WORDING of a prompt decides which part of the index gets searched ("Which insurers let you get
// a quote inside ChatGPT?" and "How can an insurance company sell products inside ChatGPT?" reached
// different corpora on the same day). Case is part of wording, and two prompts that differ only in
// it are two prompts. Only runs of whitespace are noise, because they come from pasting.
export const promptKey = (text: string): string => {
	const t = text.replace(/\s+/g, " ").trim();
	if (!t) throw new Error("not a prompt: empty");
	return t;
};

// A query's key: `<engine>:<query>`. The ENGINE is in the identity because the same words asked of
// two indexes are two different facts — different documents, different ranking, and a result from
// one says nothing about the other. Lowercased, unlike a prompt: this string is handed to a search
// engine, and every engine here is case-insensitive, so casing cannot change the answer and must not
// be able to fork a row.
export const queryKey = (engine: string, query: string): string => {
	const q = query.replace(/\s+/g, " ").trim().toLowerCase();
	if (!q) throw new Error("not a query: empty");
	if (!engine) throw new Error(`no engine for query "${q}" — a query is (engine, text)`);
	return `${engine.toLowerCase()}:${q}`;
};

// The engine and the text back out of a query key — the one decoder, so nothing else ever splits
// that string by hand. (Split on the FIRST colon only: `site:reduck.ai claude` is a perfectly good
// query and carries colons of its own.)
export const queryParts = (key: string): { engine: string; query: string } => {
	const i = key.indexOf(":");
	if (i < 1) throw new Error(`not a query key: ${JSON.stringify(key)} — expected "<engine>:<query>"`);
	return { engine: key.slice(0, i), query: key.slice(i + 1) };
};

// The left-hand side of a result key for a page an ASSISTANT READ rather than one a query ranked.
// A source has no query — the ask script returns one flat list per answer with no attribution — so
// it needs something to occupy the slot a query key occupies, and this is it.
//
// `sources:` first, never `<provider>:sources`, and that ordering is the whole of what makes it
// unambiguous: a query key is `<engine>:<text>`, so a Brave search for the word "sources" is
// `brave:sources` — which the other spelling would collide with. Nothing can produce a key whose
// first segment is `sources` except this function.
export const sourceKey = (provider: string): string => `sources:${provider.toLowerCase()}`;
export const isSourceKey = (key: string): boolean => key.startsWith("sources:");

// Tracking parameters — carried by a URL, never part of what page it is. Prefix-matched for the
// families that generate their own suffixes (utm_*, and the ad platforms' click ids).
const JUNK = /^(utm_|ga_|mc_|pk_|_hs)|^(gclid|gbraid|wbraid|fbclid|msclkid|dclid|igshid|mkt_tok|ref|ref_src|source|si|s_kwcid|yclid|twclid|ttclid)$/i;

// The canonical URL — one page, one string, so a mention count cannot be split across two rows for
// the same article. Everything stripped here is something that changes without the page changing:
// the scheme (http and https serve the same document), a `www.` that is a hosting convention, a
// fragment the server never sees, a trailing slash, and the tracking parameters above. Real query
// parameters SURVIVE, sorted — on plenty of sites `?p=123` IS the page, and dropping it would fuse
// every article on the domain into one row.
export const canonicalUrl = (url: string): string => {
	let u: URL;
	try {
		u = new URL(url.trim());
	} catch {
		throw new Error(`not a URL: ${JSON.stringify(url)}`);
	}
	if (u.protocol !== "http:" && u.protocol !== "https:")
		throw new Error(`not an http(s) URL: ${url}`);
	const host = u.hostname.toLowerCase().replace(/^www\./, "");
	const keep = [...u.searchParams.entries()].filter(([k]) => !JUNK.test(k)).sort(([a], [b]) => a.localeCompare(b));
	const qs = keep.length ? `?${keep.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}` : "";
	const path = u.pathname.replace(/\/+$/, "");
	return `https://${host}${path}${qs}`;
};

// Is this URL ours — the domain itself or any subdomain of it? Anchored on a leading dot so
// `notreduck.ai` cannot pass as `reduck.ai`, which a bare `endsWith` or `includes` would allow.
export const hostIsOurs = (url: string, domain: string): boolean => {
	const host = new URL(canonicalUrl(url)).hostname;
	const d = domain.toLowerCase().replace(/^www\./, "");
	return host === d || host.endsWith(`.${d}`);
};

// A result's key: the (query, page) PAIR, because that is what a result is. The same URL ranks for
// many queries at different ranks with different snippets, so keying on the URL alone would make
// every query after the first overwrite the one before it.
//
// The query's key is IN it, and that is identity rather than a foreign key — the join is the `Query`
// relation. But since it is here anyway, two things come free and neither needs the queries table:
// selecting a query's results (`starts_with`), and labelling one (`resultParts`).
const PAIR = " :: ";
export const resultKey = (qKey: string, url: string): string => `${qKey}${PAIR}${canonicalUrl(url)}`;

// The pair back out — the one decoder, so nothing else splits that string by hand. Split on the FIRST
// separator: a URL cannot contain " :: " but a query certainly could.
export const resultParts = (key: string): { query: string; url: string } => {
	const i = key.indexOf(PAIR);
	if (i < 1) throw new Error(`not a result key: ${JSON.stringify(key)} — expected "<query> :: <url>"`);
	return { query: key.slice(0, i), url: key.slice(i + PAIR.length) };
};

// ─── the two calls ───────────────────────────────────────────────────────────────────────────────

// Ask one assistant one question, once. `opts` is WHICH browser — and therefore which account, whose
// memory and settings shape the answer. The caller passes it because only the agent knows whose
// account this is (config.ts PROVIDERS); core must not choose an identity.
export const ask = (question: string, opts?: RunOpts): Promise<Ask> =>
	run<Ask>(scripts.ask, { question }, opts);

// Search one query on one engine.
export const search = (query: string, opts?: RunOpts): Promise<Search> =>
	run<Search>(scripts.search, { query }, opts);

// Every query in ONE request, each on its own browser, one outcome each — a rejection never removes
// its siblings' results. A draw's whole reformulation set is one request and one poll rather than
// one of each, which also spreads them across separate cloud IPs: Brave's limiter is IP-keyed, and
// its own contract says to back off 30–60s after a captcha.
export const searchAll = (
	queries: readonly string[],
	opts?: RunOpts
): Promise<PromiseSettledResult<Search>[]> =>
	runAll<Search>(queries.map((query) => ({ addr: scripts.search, args: { query } })), opts);

// Submit a URL for re-crawling. Not called by the funnel — the MVP writes nothing to Brave — but it
// is the one lever the index offers an owner, so it is bound here rather than rediscovered later.
export const submit = (url: string, opts?: RunOpts): Promise<Submit> =>
	run<Submit>(scripts.submit, { url: canonicalUrl(url) }, opts);
