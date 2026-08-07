// The reduck scripts on the AI-search surface. `sflock bind --client geo` generates schema.ts; the
// client (index.ts) imports both. Addresses live ONLY here.
//
// Two hosts, one client, because it is one substrate: an assistant answers, and the index behind its
// web tool decides what it could have answered from. Splitting them into two clients would put the
// two halves of a single question in two files.

export const scripts = {
	// The assistant. Returns the answer, and — the reason this whole agent exists — the queries its
	// web_search tool actually issued plus every source it read. `loggedIn: true`: claude.ai has no
	// anonymous chat, so this only ever runs on a paired browser.
	ask: "reduck/claude.ai/ask",
	// The index. Anonymous (`loggedIn: false`), so it runs on the cloud. Its own contract carries the
	// two cautions the funnel obeys: `operatorsApplied: false` means Brave dropped the operator and
	// answered a RELAXED query, and a bare `site:` is a ranked sample rather than an inventory.
	search: "reduck/search.brave.com/search",
	// Not called. The MVP diagnoses and writes nothing to Brave — and the skill wants an exact-phrase
	// absence proof before a submission anyway. Listed because this is where addresses live, the same
	// way `reddit`'s `info` is listed for a script only ever run by hand.
	submit: "reduck/search.brave.com/submit_url"
} as const;
