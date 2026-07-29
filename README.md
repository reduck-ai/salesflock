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
   The converse holds too: **prose is authored, not compiled.** A judgment's instructions are
   a document, so they live in the Prompt page's *body* — never a column, which would compile
   into a type nothing can validate. Columns carry what a machine reads; the body carries what
   a person writes, and the CRM's own editor is the authoring surface. Prose shared by several
   Prompts (who we are) is written ONCE on its own page and pulled into each body as a Notion
   *synced block* — the same "declare it once, both consumers read it" rule the code obeys.
   Exactly two layers, Pages then Prompts: a section serving a single Prompt has earned no page.
   The cost of authored-not-compiled is that the text can change under a past judgment — so every
   Decision **pins the fingerprint of the instructions it read**, beside the model that read them.
   A relation names which prompt; only the fingerprint says which *wording*, and it catches an edit
   that arrived through a synced page the prompt doesn't even own.

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

10. **The agent is a folder; the core is a seam; the decision names its agent.** Everything
   agent-specific lives under `agents/<id>/`; everything shared lives under `src/` (the engine)
   and `app/` (the review surface). They meet at `$core` (shared primitives, never re-implemented)
   and the roster `agents/index.ts` (`$agents`): every agent registered once, resolved **per
   Decision** by its kind — all agents share ONE Decisions table, so which config semantics and
   which evidence renderer govern a row is data on the row, never a build-time binding. An agent
   *is* a fixed contract resolved by convention — `config.ts` (pipeline semantics), an
   `evidence.ts` (+ optional `evidence.css` skin) that renders what it judges, and the funnel
   wiring (`tools.ts` / `cli.ts`) — plus its registration: the checklist atop `agents/index.ts`,
   the ONE authoritative list (docs point there, never restate it). So the agent owns its
   evidence's *identity* (what it is, how it looks) and its funnel; core owns the *engine*
   (judge, stores, clients) and the *review machinery* (dock, highlighting, theme). The agent
   renders in theme *tokens*, never a hardcoded palette — the proof the line is right: add an
   agent, or flip the theme, and neither side breaks the other.

## Applied

`agents/linkedin-leads/` is the worked example: a canonical `Company` and `Person`
(LinkedIn), source lenses and pipeline rows kept off them, one composite tool per thing
`reduck run` can't express. Its method — the stage sequence — lives in the
`linkedin-leads` skill; its identity lives in the CRM, as its Prompt bodies (with the generic
part — who we are — a synced block from one shared page, per #5).
`former-rpa-pms`, `x-engage` (on X), `lk-engage` (LinkedIn engagement) and `reddit-engage`
(Reddit engagement) realize the same contract (#10); the review app resolves each Decision's
agent from the roster (`$agents`).
