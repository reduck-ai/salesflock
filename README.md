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
   *reviews* (`sflock decisions` — an agent's Decisions, `sflock prompts` — its live Prompt
   contracts, and `sflock docs` — the Writer's documents, which belong to no agent at all; over
   `createReviewer` or the Store seam, no entity bridge) and *calibrates* (`sflock eval`).
   Calibration is the counterpart of authoring: publishing the next version of a judgment's
   instructions is worth nothing unless something says it is better, and for a judgment whose output
   is PROSE nothing can — no `===`, no schema. So the scorer is itself a Prompt, authored and
   versioned like the one it grades, and a run reports which version of it ruled. Its ground truth is
   the review history and is never written down: a review already freezes the evidence, the model's
   attempt and the human's word, so the corpus is a QUERY — a checked-in copy would be a second
   record of rows the CRM already owns, stale the moment anyone reviews again. Review is read-only with exactly two
   exceptions, and both are *prose* exceptions: `sflock docs push` hands a revision of a document
   back — through the app's own save sink, so it lands in the editor a human has open rather than
   behind a reload — and `sflock prompts push` publishes the next version of a judgment's
   instructions. Text a person will edit is the only thing `sflock` writes; pipeline state stays the
   runtime's. The per-agent runtime binary is *action* (compose scripts, persist, advance the
   funnel). Setup describes, the operator CLI inspects, runtime does.

   The review *app* is the exception, and it is the one place a human's click is itself an act:
   confirming a decision may perform it (`PromptSpec.act` — post the reply, send the message)
   in the same request that records it. The alternative is worse than the coupling: approving
   in one pass and performing in another gives a decision two truths — approved, and done — and
   a window between them that some third thing has to model, watch and reconcile. So the act
   runs after every gate and before any write, its result rides into the same patch as the
   status it earns, and a failure persists nothing and leaves the row in the queue. The act
   guards on its own evidence in the world (a permalink already recorded), never on a status,
   so confirming twice cannot do it twice.

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
   Transclusion gives that body **two readers wanting opposite things, so it has two projections**:
   *inference* compiles it flat (a marker would be chrome in the model's prompt, and those bytes are
   what a judgment fingerprints), while *authoring* delimits each borrowed region and names the page
   it comes from — because prose you cannot attribute is prose you cannot safely edit, and editing a
   shared section in place forks it away from every other Prompt that reads it. Both projections come
   from ONE traversal, so they can never disagree about what the document says.
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
   Judging and persisting stay distinct too, and the line between them is the human:
   **a Decision exists iff a person will rule on it.** A calibrated stage — one whose prompt is
   held green against a committed ground truth — judges and keeps only what a later reader needs
   (a column on its entity, a comment on its page). Minting a Decision there and committing it in
   the same breath would fake a review that never happened, and the queue a human reads is exactly
   the wrong place to put a row nobody will open. The eval, not the CRM, is where such a stage's
   record lives: a miss is fixed by a line in the ground truth, not by overturning a row.

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

`agents/reddit-engage/` is the worked example, and today the only agent: a funnel that judges
then drafts, and a human gate whose click posts. Its two tables are #4 taken literally — the
thread (what Reddit says, plus how we judged it) and the outreach (our conversation on it, one
row per thread we chose to engage), both keyed on the same canonical URL. What is owed is
*derived* from that data, never a rung anyone wrote down: no Tier ⇒ judge it, a good Tier and no
outreach ⇒ draft it. So a run that dies mid-funnel leaves the state its own data describes, with
nothing to reconcile. Its identity lives in the CRM, as its Prompt bodies (with the generic
part — who we are — a synced block from one shared page, per #5). The roster (`$agents`) still
resolves each Decision's agent per row, because that is what makes adding the next agent a
registration rather than a refactor (#10).
