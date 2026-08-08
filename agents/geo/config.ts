// geo — are we cited by AI assistants, and if not, why not.
//
//   ask     one assistant, one question, one draw → the answer recorded, then in the same act:
//           every query it issued is cross-validated on the index its web tool reads (Claude's
//           SERP IS Brave's SERP — the skill's first principle), and every page it read or that
//           ranked is fetched. THE daily lever: run it and the whole funnel is measured.
//   search  one query on the index, by hand — the investigation door (site: audits, probes).
//           Authoring a query IS searching it; there is no add step and no queries table.
//
// Then the diagnosis, which needs no model: it never searched / it searched and never saw us / it
// saw us and skipped us / it named us. Four causes, four different fixes, and guessing between them
// wastes months.
//
// ONE INTENT TABLE AND THREE APPEND-ONLY LOGS — the split is the law the identity comment in
// src/clients/geo/index.ts states: things whose identity is a moment ACCUMULATE; things whose
// identity is inherent CONVERGE.
//   GEO Prompts    the questions we want to win. The only thing that exists before any observation,
//                  so the only intent row. Hand-written, converges on its text.
//   GEO Answers    one draw. Three draws of one prompt are three rows, because the assistant answers
//                  differently each time and that variance IS the measurement.
//   GEO Searches   one query DONE — Claude's or ours. `Conversation` set says Claude issued it in
//                  that draw (the ask tool cross-validated it minutes later; that SERP is the record
//                  of its search); empty says direct. The raw SERP lives whole in the row's body.
//   GEO Results    one LOOK — one page fetched at one instant, its visible text in the body.
//                  `Conversation` set says the model read this page in that draw.
//
// OBSERVATIONS NEVER RELATE TO OBSERVATIONS. The only relation is Prompt ↔ Answers (intent ↔ its
// draws); everything else joins by VALUE + time — `Conversation` (the draw's own id, stamped on
// every row the draw caused), `Key` (the normalized query, src/clients/geo `queryKey`), canonical
// `URL`. Each row mirrors its script's raw output; the coupling logic lives in the ask TOOL, not in
// data edges. Every observation row is CREATED COMPLETE and never touched — no patch, no re-set
// body, no replaced relation, no retry queue: a failed look or refused search IS the observation,
// and the next run simply mints a fresh one.
//
// NO DECISIONS, NO PROMPT SPECS, NO LLM. Every verdict here is a string comparison over evidence we
// fetched, derived at read time under today's config — rank is the SERP's order in a Search body,
// mentions are counted off a look's body under today's BRAND, so widening an alias re-reads the
// whole corpus with no migration. Hence no `entity`, no `prompts`, no `ladder`, no `drop`: the
// operating agent reading these tables is the intelligence; this is the instrument.

import type { AgentConfig } from "../../src/stores/index.js";
import { models } from "../../src/models.js";
import type { RunOpts } from "../../src/clients/reduck.js";
import { scripts } from "../../src/clients/geo/scripts.js";

// WHO we are looking for. One declaration, read by everything that asks "is this us": the mention
// count on a fetched page, whether a look or a ranked URL is ours, and whether an answer named us.
//
// `aliases` is the whole knob, and it is matched on WORD BOUNDARIES (src/clients/http.ts `count`),
// so a short name cannot fire inside an unrelated word. Widen it freely: a mention count is derived
// from each look's stored body at read time, so a wider alias set applies to the whole corpus on the
// next read — no stored number to invalidate, no stamp, no re-crawl.
export const BRAND = {
	name: "Reduck",
	domain: "reduck.ai",
	aliases: ["reduck.ai", "reduck"]
} as const;

// WHERE each job runs, one entry per job — because the choice is not only which browser but how it
// egresses, and the two jobs answer differently.
//
//   ask     a PAIRED browser, and there is no alternative: `reduck/claude.ai/ask` is declared
//           loggedIn (claude.ai has no anonymous chat), so the REST run door refuses it on the cloud.
//           The identity caveat is louder here than anywhere else in this repo: a device IS an
//           account, and the ANSWER ITSELF depends on which one — its memory, its settings, its
//           project instructions all shape what gets searched and said. `sflock devices` lists the
//           paired ids. Re-verify after any re-pair.
//   search  the CLOUD, signed out, on a plain DATACENTER address — no `country`. Brave is a public
//           index and reading it as nobody means no account of ours can be rate-limited or challenged
//           by scraping. Brave's limiter is IP-keyed and its contract says to back off 30–60s after a
//           captcha; a cloud browser per query in one `searchAll` request spreads them across
//           separate IPs, and a query that fails leaves a Search row carrying the reason, so the
//           record says refused rather than nothing.
//
//           NO RESIDENTIAL EGRESS, and that is measured rather than assumed. `country` routes through
//           a residential proxy whose bandwidth is metered separately: with it, every run answered
//           `403 Managed (cloud) browser is unavailable — you've reached this period's browser-time
//           or bandwidth quota`, while the SAME query on `region: "us-east-1"` with no `country`
//           answered normally in 5.4s. The quota is the proxy's, not the browser's.
//
//           And Brave does not need one. It serves a datacenter address the same results it serves a
//           residential one — `operatorsApplied: true`, full result sets — which is exactly where it
//           differs from Reddit (see reddit-engage/config.ts: datacenter pools there get "You've been
//           blocked by network security", and residential egress is the only lever). A public index
//           has no reason to care who is asking, and it doesn't.
//
// The paired browsers, named by the account each is signed into — the one thing that matters about a
// device and the one thing its id cannot tell you. `sflock devices` lists the ids.
const DEVICES = {
	pro: "c12b4b27-9a32-4bdf-b5b9-ecad926c3584",
	tester: "3279bc8b-6047-4048-9b4d-4659bf98ebd8"
} as const;

// Run the SEARCH on a paired browser instead of the cloud. One word, and it is the whole switch to a
// fully local agent: `ask` already runs on a device (it has no choice — the script is loggedIn), and
// a look never opens a browser at all.
//
// It BUYS one thing: no cloud browser quota. The hosted browser's time and bandwidth run out, and
// the run door then answers `403 Managed (cloud) browser is unavailable` for every search until the
// period resets — measured, and it is what stops a scan dead.
//
// It COSTS three, and the first is a change to the MEASUREMENT rather than to the plumbing:
//   locale   `country` is a CLOUD-only option (reduck.client.ts: the server refuses it on a device)
//            and the search script takes no locale argument of its own — read its contract: query,
//            offset, exactMatch, nothing else. So a local search measures Brave FROM WHERE YOU SIT.
//            US and FR rank differently, so rows gathered under the two are not comparable — which
//            is exactly what the `Egress` column on a Search row exists to keep visible.
//   IP       every query then leaves from your own address, where a cloud browser per query spread
//            them. Brave's limiter is keyed on it.
//   uptime   a paired browser has to be awake. The cloud target needed nothing of ours to exist.
//
// TRUE — the operator's call, and what changed to make it viable is the SCRIPT, not Brave: the
// search script now answers Brave's challenge itself (it is a one-click proof-of-work captcha, and
// v8 clicks Verify and re-settles, ~3s), so a rate-limited local run heals in-page instead of
// failing the query AND leaving your own browsing walled. The costs above still stand — locale
// comparability most of all (the Egress column is what keeps mixed rows tellable-apart) — and the
// pacing discipline still applies: searchAndRecord runs a device target one query at a time,
// because six in one burst once earned this machine an HTTP 429 that hit ordinary browsing too.
//
// What flipping this BACK buys, when wanted: cloud egress from a fixed region (us-east-1), rows
// comparable across operators, nothing borrowed from the machine's own IP. What looked like a
// cloud outage once was the RESIDENTIAL PROXY's quota, never the datacenter path — and the one
// real cloud captcha since is exactly the case v8 now clears.
//
// Also measured, and it is the reason this is a switch rather than a fork: the two egresses see
// substantially the same Brave. On two queries, 15/20 and 18/20 of the results matched, mean rank
// shift 1.7 and 1.9, same top five in a different order. Local costs comparability at the margins,
// not the measurement.
export const LOCAL_SEARCH = true;

export const TARGETS = {
	ask: { target: { deviceId: DEVICES.pro } },
	search: LOCAL_SEARCH ? { target: { deviceId: DEVICES.pro } } : { target: "cloud", region: "us-east-1" }
} as const satisfies Record<"ask" | "search", RunOpts>;

// The index behind an assistant's web tool. Adding one is an entry plus a script address.
export const ENGINES = {
	brave: { search: scripts.search, target: TARGETS.search }
} as const;

// The assistant, AND the index it reads — one declaration, because it is not a free choice. An
// answer can only cite what ITS engine retrieved, so probing Claude's queries against a different
// index would measure something that never decided anything. That pairing is the whole first
// principle of the skill this agent implements — and it is what lets one Search row stand for a
// query Claude did: the cross-validation reads the same index its web tool read.
export const PROVIDERS = {
	claude: {
		ask: scripts.ask,
		engine: "brave",
		// What the account's UI is set to. NOTHING VERIFIES THIS — the script returns no model — so it
		// is an operator's assertion about a browser session, exactly like OWNER in reddit-engage. It
		// is stamped on every Answer all the same: the answer depends on it, and recording the
		// assertion beats recording nothing.
		model: "claude-opus-4.5",
		target: TARGETS.ask
	}
} as const;

export type ProviderId = keyof typeof PROVIDERS;
export type EngineId = keyof typeof ENGINES;
export const DEFAULT_PROVIDER: ProviderId = "claude";

// The engine a provider reads — the one place the pair is resolved, so no caller re-states it.
export const engineOf = (provider: string): EngineId => {
	const p = PROVIDERS[provider as ProviderId];
	if (!p) throw new Error(`no provider "${provider}" — declare it in agents/geo/config.ts PROVIDERS`);
	return p.engine as EngineId;
};

export default {
	destination: "notion",
	// The model NAMES this agent's code addresses; the table ids behind them belong to whoever is
	// running it, so they live in models.local.json (src/models.ts) and `sflock init` writes them
	// after building these four tables. Each name is also the file name of its contract —
	// agents/geo/schema/<name>.json, which is what `init` builds the table FROM.
	models: models("geo", ["GEOPrompts", "GEOAnswers", "GEOSearches", "GEOResults"])
	// No `entity`, `prompts`, `ladder`, `drop` or `model`: this agent mints no Decision and calls no
	// LLM. Declaring any of them would be fiction — see src/stores/index.ts on why `entity` is optional.
} as const satisfies AgentConfig;
