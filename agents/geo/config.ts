// geo — are we cited by AI assistants, and if not, why not.
//
//   ask     one assistant, one question, one draw → the answer, the queries it ACTUALLY searched,
//           and every source it read. Repeat: one ask is a draw, not a measurement.
//   search  each harvested query, on the index that assistant's web tool reads → the ranked pages.
//   read    each ranked page over plain HTTP → can a crawler read it, and does it name us.
//
// Then the diagnosis, which needs no model: it never searched / it searched and never saw us / it
// saw us and skipped us / it named us. Four causes, four different fixes, and guessing between them
// wastes months.
//
// FOUR TABLES, and the split is what each row IS rather than what stage wrote it:
//   GEO Prompts   the questions we want to win. Hand-written, and the only hand-written thing.
//   GEO Answers   one run of one assistant. Accumulates — three draws of one prompt are three rows,
//                 because the assistant answers differently each time and that variance IS the
//                 measurement.
//   GEO Queries   one (engine, query) we have searched. Converges.
//   GEO Results   one (query, page). Converges.
//
// NO DECISIONS, NO PROMPTS, NO LLM. Every verdict here is a string comparison over evidence we
// fetched, so there is nothing for a human to rule on and nothing to calibrate — hence no `entity`
// (no pipeline row for a Decision to bind to), no `prompts`, no `ladder`, no `drop`. The operating
// agent reading these tables is the intelligence; this is the instrument.
//
// THE ONE RULE THE SCHEMA OBEYS: store the raw observation and derive under today's config. Where
// the raw is too big to store — a page body — store the reduction AND stamp the config it was
// derived under (`Mentions` + `Brand`), so changing what counts as a mention re-reads instead of
// silently leaving old numbers behind. Everything else (was it cited, did it read us, is it
// readable, is it ours) is computed at read time from columns that never go stale.

import type { AgentConfig } from "../../src/stores/index.js";
import type { RunOpts } from "../../src/clients/reduck.js";
import { fingerprint } from "../../src/prompts.js";
import { scripts } from "../../src/clients/geo/scripts.js";

// WHO we are looking for. One declaration, read by everything that asks "is this us": the mention
// count on a fetched page, whether a source or a result is ours, and whether an answer named us.
//
// `aliases` is the whole knob, and it is matched on WORD BOUNDARIES (src/clients/http.ts `count`),
// so a short name cannot fire inside an unrelated word. Widen it when the market calls us something
// we do not — and note that widening it invalidates every stored `Mentions`, which is exactly what
// the `Brand` stamp below exists to catch: the affected results re-read themselves on the next run.
export const BRAND = {
	name: "Reduck",
	domain: "reduck.ai",
	aliases: ["reduck.ai", "reduck"]
} as const;

// The stamp `Mentions` carries. It covers everything that changes what a mention IS, so any edit to
// the aliases (or the domain) makes every counted result owe a re-count. Same idiom, for the same
// reason, as a Decision pinning its `Instructions hash`: a stored derivation must say what it was
// derived under, or it quietly becomes a lie.
export const brandStamp = (): string =>
	fingerprint(BRAND.domain, ...[...BRAND.aliases].sort());

// WHERE each job runs, one entry per job — because the choice is not only which browser but how it
// egresses, and the two jobs answer differently.
//
//   ask     a PAIRED browser, and there is no alternative: `reduck/claude.ai/ask` is declared
//           loggedIn (claude.ai has no anonymous chat), so the REST run door refuses it on the cloud.
//           The identity caveat is louder here than anywhere else in this repo: a device IS an
//           account, and the ANSWER ITSELF depends on which one — its memory, its settings, its
//           project instructions all shape what gets searched and said. `sflock devices` lists the
//           paired ids. Re-verify after any re-pair.
//   search  the CLOUD, signed out. Brave is a public index and reading it as nobody means no account
//           of ours can be rate-limited or challenged by scraping. Brave's limiter is IP-keyed and
//           its contract says to back off 30–60s after a captcha; a cloud browser per query in one
//           `searchAll` request spreads them across separate IPs, and a query that fails simply
//           leaves `Searched at` empty, so the next run retries it.
export const TARGETS = {
	ask: { target: { deviceId: "c12b4b27-9a32-4bdf-b5b9-ecad926c3584" } },
	search: { target: "cloud", region: "us-east-1", country: "US" }
} as const satisfies Record<"ask" | "search", RunOpts>;

// The index behind an assistant's web tool. Adding one is an entry plus a script address.
export const ENGINES = {
	brave: { search: scripts.search, target: TARGETS.search }
} as const;

// The assistant, AND the index it reads — one declaration, because it is not a free choice. An
// answer can only cite what ITS engine retrieved, so probing Claude's queries against a different
// index would measure something that never decided anything. That pairing is the whole first
// principle of the skill this agent implements.
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
	models: {
		GEOPrompts: "9505a816-bd1a-4f8f-9a5c-0872f1079ebc",
		GEOAnswers: "8320e9d6-a66d-4e79-a75b-dcfb09373231",
		GEOQueries: "9c9a9e4e-f0bd-4829-97ee-1ea7842a6e8b",
		GEOResults: "6803195c-4024-4622-87b7-e79ebbae9d07"
	}
	// No `entity`, `prompts`, `ladder`, `drop` or `model`: this agent mints no Decision and calls no
	// LLM. Declaring any of them would be fiction — see src/stores/index.ts on why `entity` is optional.
} as const satisfies AgentConfig;
