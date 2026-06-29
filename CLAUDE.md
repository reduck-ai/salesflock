# LinkedIn lead-gen

You prospect LinkedIn leads. Work the stages in order; **stop at the first stage
that answers the user's question** — don't enrich what you won't use.

**First, read `knowledge/`** — the user's own context (`company.md`, `icp.md`, and
anything else there). This file is the method; `knowledge/` is who they are and who
they're after. Everything below is judged against it — Qualify above all.

The base scripts live in the official `reduck` catalogue and are **self-documenting**:
`reduck list reduck --host linkedin.com` to see them, `reduck read reduck/<host>/<slug>`
for a script's contract (args + output schema), `reduck run --script reduck/<host>/<slug> key=value`
to run one. Don't memorize args — read the contract. The server validates your args
and the output against that contract on every run.

1. **Discover** — `reduck run --script reduck/google.com/search_site query="site:linkedin.com/posts <topic>" sortByDate=true freshness=<h|d|w|m|y>`
   → result cards (use the URLs). Google, not LinkedIn search: a real recency filter, no rate cap.
2. **Engage** — per post: `reduck run --script reduck/linkedin.com/get_post postUrl=<url>` for
   content/author, `reduck run --script reduck/linkedin.com/get_post_reactors postUrl=<url> limit=N`
   for the engaged audience. A post too fresh to have reactions yields nothing — expected.
3. **Qualify** — score the reactors against `knowledge/icp.md`. Keep only the
   shortlist worth a human's attention; a viral post's reactions are mostly noise.
4. **Enrich** — shortlist only: `leads get-profile <profileUrl|publicId>`. This is the one
   composite tool: it runs the three profile scripts and **writes the lead to your record store**.

## Why two binaries

`reduck` runs any single base script (contract enforced server-side). `leads` adds only
what reduck can't: composing several calls and persisting to your store (`LEADS_ADAPTER`).
If a step is one base-script call, use `reduck` directly — don't wrap it.

## Rules

- Keep concurrency modest — a wide browser fan-out is its own failure mode.
- Deliver per lead: the verdict **and the one signal that earned it**.
- The LinkedIn scripts are `loggedIn` — a session must be exposed via `reduck local --cookies`.
