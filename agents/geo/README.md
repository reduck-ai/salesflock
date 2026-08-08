# geo

Are we cited by AI assistants, and if not, why not. This agent is the **instrument**; the
operating agent reading its tables is the intelligence — it mints no Decision, declares no
prompt and calls no LLM, so `sflock decisions`/`learn`/`eval` and the review app do not apply.

## The two levers

    prompts add → ask → search        (each fetches every page it observed, on the spot)

`ask [prompts…]`: one new draw per prompt (an ask is a draw, not a measurement — run again for
another) → the answer, the queries it actually searched, and every source it read fetched now.
`search [queries…]`: a fresh SERP per query on the index that assistant's web tool reads
(Brave, for Claude — calibrated once: 33 of the 36 pages Claude read across five draws were in
Brave's top-20 for the query Claude itself issued, so Brave's ranking decides what Claude
reads) — the SERP lands whole in the query's own body, replacing the last one, and every
ranked page is fetched now. Name what you want, or name nothing and the lever takes
its whole table. That is all the control there is: no `--dry-run` (a run's cost is exactly the
list you gave it), no retry queue (a failed fetch records its reason on the row and the next
run that observes the page fetches it again), no third stage. Then the diagnosis, derived at
read time from the data: **No search / Not retrieved / Passed over / Cited** — four causes,
four different fixes.

The one rule the tables obey: columns are keys and relations; the **raw observation lives in
the row's body** (a query's SERP as JSON, a page as its visible text); everything else — rank,
mentions, readable, ours — is derived at read time, so improving a definition reclassifies the
whole corpus with nothing stored to go stale. A Result row is ONE PAGE, converged on its
canonical URL, however many queries rank it and draws read it.

## Running

From `salesflock/`, after `npm run build`:

    node dist/agents/geo/cli.js prompts add "Which tools let AI agents automate websites?"
    node dist/agents/geo/cli.js ask            # one draw per prompt (or name the prompts)
    node dist/agents/geo/cli.js search         # fresh SERP per query (or name the queries)

`geo --help` lists the four nouns (prompts, answers, queries, results) and the stages; every
command prints JSON on stdout.

## Setup

- Tables: `sflock init --parent <notion page>` builds all four from `schema/*.json` (they
  relate to each other, so always as a set); ids land in `models.local.json`.
- Credential: `REDUCK_API_KEY` — every run goes over the Reduck REST door.
- `ask` runs on a paired browser (claude.ai has no anonymous chat) — a device IS an account,
  and the answer depends on which one. `search` runs on the cloud, signed out. Both are
  declared in `config.ts` (`DEVICES`, `TARGETS`), with the measured reasoning beside them.

## Where things live

- `config.ts` — BRAND (who counts as "us"), providers, engines, egress. The one file to edit.
- `tools.ts` — the funnel and every derivation; each stage's top comment is its contract.
- `../../src/clients/geo/` — the two base scripts and the identity keys.
- The domain **why** (why Brave, what each diagnosis is worth doing about) is the
  `geo_brave` skill (`.claude/skills/geo_brave/SKILL.md`), not this repo.
