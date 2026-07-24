# linkedin-leads — maintainer note

This is the ORIGINAL salesflock funnel. `former-rpa-pms` and `x-engage` came later and
established the system-wide invariants (see `salesflock/README.md` and the "Invariants"
section of the `init_salesflock` doc) that were never back-ported here. Noticed 2026-07-24
during an audit — **the code is the source of truth, so re-verify before trusting this note;
it may be stale by the time you read it.**

## Why the drift matters: a shared CRM

`config.ts` points People / Companies / Leads / Sourcing / Decisions / Prompts at the **same**
Notion data sources as `former-rpa-pms` (identical ids). The two are two funnels over **one**
CRM, told apart only by their Prompt rows and stage logic. So a stage here that isn't
monotonic can move a Lead the other funnel is managing.

## Known drift from the current invariants (audit finding, not yet fixed)

1. **No monotonic guard.** `enrich` / `qualify` / `engage` (`tools.ts`) overwrite `Status`
   forward unconditionally — no `rank` / no-op-on-settled like `former-rpa-pms`'s `LADDER`.
   This violates the "stages are monotonic and idempotent" invariant.
2. **`search` idempotency bug (`tools.ts`, the `p.created` branch).** It creates a Lead only
   when the *Person* was created this run. On the shared table a Person may already exist
   (created by the other funnel) with no Lead → then no Lead is ever created for it. The fix
   `former-rpa-pms` uses: key on lead-existence (`leadStatus(url) === null`), not `p.created`.
3. **No `existing` / `skipped` reporting.** A re-hit here silently re-writes, instead of
   reporting the subject was already in the CRM (as `former-rpa-pms` / `x-engage` do).

## Not drift (intended differences)

The extra `engage` stage + the `dependsOn` DAG and `get-company` / `put-lead` are this agent's
reason to exist; `former-rpa-pms` deliberately omits them for a clean 4-stage funnel. Both
agents satisfy the standard agent contract (`config.ts`, `evidence.ts`, `tools.ts`, `cli.ts`,
`schema/`, `knowledge/`); LinkedIn evidence needs no `evidence.css` (its `### field` markdown
is styled by core), unlike `x-engage`'s x.com card.
