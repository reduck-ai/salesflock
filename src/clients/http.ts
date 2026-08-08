// The STATIC client — plain HTTP, no browser. The counterpart of clients/reduck.ts: that one drives
// a real browser through a script, this one asks a server for bytes and reads what comes back.
//
// It exists because two different questions have the same answer, and neither needs a browser:
//   can a crawler read this page at all?   → the status, and whether there is any text under it
//   does this page name us?                → the text, counted
// A search engine's crawler is a plain HTTP client too, so fetching this way is not an approximation
// of what it sees — it IS what it sees. A browser would be the wrong instrument: it runs the
// JavaScript that a crawler does not, so a page that renders only client-side would look fine.
//
// TWO FAILURE MODES THAT LOOK IDENTICAL AND NEED OPPOSITE FIXES, which is why this returns the status
// and the text length separately rather than one "readable" verdict:
//   403 / a challenge page  → bot protection. Nothing written on the page can help.
//   200 with no text        → a client-rendered shell. The content exists but only in a browser.
// A caller that fused them would prescribe content work for an infrastructure problem.
//
// It never throws for the site's sake: a refusal, a timeout and a DNS failure are all ANSWERS about
// the URL, so they come back as `{ok:false, status, error}` rather than as an exception. Only the
// caller's own mistakes (a malformed URL) throw. `text` is empty when there was nothing to read.
//
// It returns the page BOTH WAYS, because two readers want different things out of one fetch: `text`
// is what gets counted and measured, `html` is the bytes as served — kept because a status alone
// cannot tell you WHY a page is unreadable. Measured: producthunt.com answers 403 with 5.7 KB whose
// first words are "Just a moment", i.e. a Cloudflare wall rather than a refusal aimed at us; that
// distinction lives in the markup and nowhere else. Carrying it costs nothing — the bytes were
// already in hand and were being dropped.

import { gate } from "../concurrency.js";

// One gate for one backend, the rule concurrency.ts states: the backend here is "the open web", and
// what is scarce is our own politeness — a fan-out over one search's results hits ~20 hosts at once,
// which is fine, but a drain over every result of every query would hit thousands. Bounded here, in
// the client that does the I/O, so no caller has to remember.
export const HTTP_CONCURRENCY = Number(process.env.HTTP_CONCURRENCY) || 8;
const slot = gate(HTTP_CONCURRENCY);

const TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS) || 15_000;
// Bodies are read to count words in them and then thrown away, so the cap is about not holding a
// 50 MB page in memory, not about correctness. A page whose first 4 MB does not name us does not
// name us in any way a search engine would weigh.
const MAX_BYTES = 4_000_000;

// Not a disguise — a bare `node` User-Agent is refused by a lot of CDNs for being a bot, and a
// refusal we caused ourselves tells us nothing about whether a real crawler can read the page. This
// is the most ordinary string there is, so the answer is about the site's posture and not about ours.
const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

export interface Fetched {
	url: string; // the URL asked for
	finalUrl: string; // where the redirects ended — a soft-404 landing on the homepage shows up here
	ok: boolean; // a 2xx that yielded bytes; false covers a refusal, a timeout and a DNS failure alike
	status: number; // HTTP status, or 0 when the request never got one (timeout, DNS, TLS)
	html: string; // the page as served, decoded but otherwise untouched. Empty when nothing was read
	text: string; // the page's visible text, tags and scripts removed
	error?: string; // why there is no status — network-level only, never an HTTP error
}

// WHICH CHARACTER SET the bytes are in. It used to be UTF-8, always, which is right for most of the
// web and silently wrong for the rest: decoding windows-1252 or Shift_JIS as UTF-8 replaces every
// accented character with U+FFFD, in the stored page AND in the count that decides whether we are
// named on it.
//
// The server's own declaration wins. Failing that, the `<meta charset>` in the head — sniffed out of
// the first 2 KB as latin1, which is safe because every encoding worth handling here agrees with
// ASCII in that region, so the tag reads the same whatever the document turns out to be.
const charsetOf = (contentType: string | null, bytes: Uint8Array): string => {
	const declared = contentType?.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
	if (declared) return declared.toLowerCase();
	const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
	const meta =
		head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i)?.[1] ??
		head.match(/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i)?.[1];
	return (meta ?? "utf-8").toLowerCase();
};

// Bytes → text, in the declared encoding. No dependency: Node ships full ICU, so `TextDecoder`
// already knows windows-1252, shift_jis and the rest. A label it does NOT know throws — and a
// charset we cannot name is not a reason to lose the page, so that falls back to UTF-8.
const decode = (bytes: Uint8Array, charset: string): string => {
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
};

// textOf(html) — the page's visible words. Deliberately crude, and crude is right: this measures
// whether there is prose here and whether it names someone, not what the DOM is. `<script>` and
// `<style>` go first (their contents are not visible text but ARE full of words, and a client-rendered
// page is mostly script — counting it would make every JS shell look content-rich, which is the exact
// distinction this file exists to draw). Then tags become spaces, so two words either side of a tag
// do not fuse into one.
export const textOf = (html: string): string =>
	html
		.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<[^>]+>/g, " ")
		// The handful of entities that carry words apart or together. Not a full entity decoder: the
		// text is only ever searched and measured, so `&hellip;` surviving as-is costs nothing.
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&quot;/gi, '"')
		.replace(/\s+/g, " ")
		.trim();

// factsOf(html) — the handful of MARKUP facts worth keeping when the markup itself is thrown away.
// textOf's counterpart: that reduces the page to its visible words, this to what an INDEXER reads
// off the structure — and both exist because the html is 10–30× the text and is not stored. Each
// fact's provenance differs, and the consumer must label it (geo's schema does):
//   canonical     the page's own <link rel=canonical>, VERBATIM (relative stays relative — it is a
//                 declaration, not a location). A real gate: Brave's open-source discovery client
//                 treats a same-domain canonical as a publicness signal and subjects canonical-less
//                 pages to its strictest privacy checks (web-discovery-project.es).
//   published     the PUBLISHER's claim — JSON-LD datePublished, else og:article:published_time —
//                 verbatim, junk included: parsing it into a date would launder an assertion into a
//                 fact. An index's own age chip is a different observer's claim about the same page.
//   schemaTypes   deduped JSON-LD @type list, parsed (JSON.parse per block, @graph walked) rather
//                 than regexed — a self-assertion invisible to readers.
//   h2/h3         heading counts in the served markup — the one fact here a reader actually sees.
export interface PageFacts {
	canonical: string | null;
	published: string | null;
	schemaTypes: string[];
	h2: number;
	h3: number;
}

export const factsOf = (html: string): PageFacts => {
	const canonical =
		html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1] ??
		html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i)?.[1] ??
		null;
	const types = new Set<string>();
	let published: string | null = null;
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) return node.forEach(walk);
		if (!node || typeof node !== "object") return;
		const o = node as Record<string, unknown>;
		for (const t of Array.isArray(o["@type"]) ? o["@type"] : o["@type"] ? [o["@type"]] : [])
			if (typeof t === "string") types.add(t);
		if (!published && typeof o.datePublished === "string") published = o.datePublished;
		if (o["@graph"]) walk(o["@graph"]);
	};
	for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
		try {
			walk(JSON.parse(m[1]));
		} catch {
			// a malformed block is the page's own problem; the other blocks still count
		}
	}
	published ??=
		html.match(/<meta[^>]+property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i)?.[1] ??
		html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']article:published_time["']/i)?.[1] ??
		null;
	return {
		canonical,
		published,
		schemaTypes: [...types],
		h2: (html.match(/<h2[\s>]/gi) ?? []).length,
		h3: (html.match(/<h3[\s>]/gi) ?? []).length
	};
};

// get(url) — fetch one page and reduce it to what a crawler would see. Gated, timed out, and never
// throwing on the site's behalf.
export const get = async (url: string): Promise<Fetched> =>
	slot(async () => {
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
		try {
			const res = await fetch(url, {
				redirect: "follow",
				signal: ctl.signal,
				headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*;q=0.8" }
			});
			// A non-2xx still has a BODY worth measuring: a bot-protection challenge is a small HTML
			// page, and its size is part of how you recognize one. So the body is read either way and
			// `ok` carries the verdict.
			const bytes = await readCapped(res);
			const html = decode(bytes, charsetOf(res.headers.get("content-type"), bytes));
			return {
				url,
				finalUrl: res.url || url,
				ok: res.ok,
				status: res.status,
				html,
				text: textOf(html)
			};
		} catch (e) {
			// No status at all: the request never reached a server, or the clock ran out. That is a fact
			// about the URL — one a crawler would hit too — so it is an answer, not an exception.
			const err = e as Error;
			return {
				url,
				finalUrl: url,
				ok: false,
				status: 0,
				html: "",
				text: "",
				error: err.name === "AbortError" ? `timed out after ${TIMEOUT_MS}ms` : err.message
			};
		} finally {
			clearTimeout(timer);
		}
	});

// Read at most MAX_BYTES, then stop pulling. `res.text()` would buffer the whole body first, which is
// the one thing the cap exists to prevent.
//
// BYTES, not text, and that is what makes the charset sniff above possible: the encoding is declared
// in the response — sometimes only inside the body itself — so nothing can be decoded until the head
// has been read. Decoding as it streamed meant guessing UTF-8 before the document had said otherwise.
const readCapped = async (res: Response): Promise<Uint8Array> => {
	if (!res.body) return new Uint8Array();
	const reader = res.body.getReader();
	const parts: Uint8Array[] = [];
	let seen = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
		seen += value.byteLength;
		if (seen >= MAX_BYTES) {
			await reader.cancel().catch(() => {});
			break;
		}
	}
	const out = new Uint8Array(seen);
	let at = 0;
	for (const p of parts) (out.set(p, at), (at += p.byteLength));
	return out;
};

// count(text, needles) — how many times any of `needles` appears, case-insensitively, on a word
// boundary. The boundary is what keeps a brand name from matching inside an unrelated word, and it is
// why this takes the strings rather than a caller-built regex: escaping them is this function's job,
// and a caller that forgot would silently turn a dot in a domain into "any character".
export const count = (text: string, needles: readonly string[]): number => {
	const alts = needles
		.filter(Boolean)
		.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|");
	if (!alts) return 0;
	// `\b` before a needle starting with a letter, and after one ending in one. A domain ends in a
	// letter too ("reduck.ai"), so the same rule serves both — the dot inside it is already escaped.
	return (text.match(new RegExp(`(?<![\\w.-])(?:${alts})(?![\\w-])`, "gi")) ?? []).length;
};
