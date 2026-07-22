# salesflock

A framework for sales agents that compose `reduck` browser scripts and persist to a
store. This file is the **why** — the principles every agent under `agents/` obeys.
It does not restate behavior: code is the source of truth, and each file's top comment
says what it does. If a fact can drift, it belongs in code, not here.

## Principles

1. **Code is the source of truth.** Docs carry principles, not behavior. A contract the
   server already enforces is never re-typed by hand — it's compiled (`sflock`).

2. **The operator CLI vs the funnel binary.** `sflock` is agent-agnostic and never mutates
   the pipeline: it *sets up* (compile a destination's or source's contract → a TS type) and
   *reviews* (`sflock decisions` — inspect an agent's Decisions read-only, over `createReviewer`,
   no entity bridge). The per-agent runtime binary is *action* (compose scripts, persist, advance
   the funnel). Setup describes, review inspects, runtime does.

3. **`reduck` is a runner, not a schema source.** One base-script call → run it with
   `reduck run` directly. Wrap it in a tool **only** for what `reduck` can't do: compose
   several calls, or persist to your store. A wrapper that adds neither shouldn't exist.

4. **Separate the shared from the specific.** A canonical entity (a business, a person —
   facts true for everyone) never carries source-specific fields. A source's own view
   attaches as a *satellite* pointing at the canonical entity; pipeline state (an
   outreach) is a *join*, not a column on either. Don't pollute what everyone reads.

5. **Contracts are ground truth; types are generated.** Destinations compile via
   `describe → TS` (`sflock pull`); sources compile their reduck output schema → TS
   (`sflock bind`). The server validates args and output against the contract on every run.

6. **Idempotency by construction.** One generic `upsert`; every persist-tool declares the
   single unique key that makes a re-run converge instead of duplicate. No key, no tool.

7. **One job per tool (Occam).** Fetching, persisting, and judging are distinct jobs.
   A judgment is a **pure function of its context** — never a fetch — so it re-runs when
   the criteria change and fans out in parallel. Shared context is computed once and
   frozen, then handed to each per-item call; only the verdict is per-item.

8. **The state seam is yours; the store is theirs.** Agents write through the `Store`
   interface (`src/stores/`); the destination is chosen in the agent's `config.ts` (default
   `notion`, so it runs out of the box), never in code. Today Notion is the full store;
   HubSpot implements the setup half (`describe`) with its write path stubbed until needed.

9. **Stage, and stop early.** Work proceeds in stages; stop at the first stage that
   answers the question — don't enrich what you won't use.

## Applied

`agents/linkedin-leads/` is the worked example: a canonical `Company` and `Person`
(LinkedIn), source lenses and pipeline rows kept off them, one composite tool per thing
`reduck run` can't express. Its method — the stage sequence — lives in the
`linkedin-leads` skill; its identity lives in `agents/linkedin-leads/knowledge/`.
