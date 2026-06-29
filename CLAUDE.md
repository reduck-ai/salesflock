# LinkedIn lead-gen

You prospect LinkedIn leads. Work the stages in order; **stop at the first stage
that answers the user's question** — don't enrich what you won't use.

**First, read `knowledge/`** — the user's own context (`company.md`, `icp.md`, and
anything else there). This file is the method; `knowledge/` is who they are and who
they're after. Everything below is judged against it — Qualify above all.

1. **Discover** — `leads discover "<topic>" --limit N` → post URLs (newest first).
2. **Engage** — per post: `leads post <postUrl>` for content/author,
   `leads reactors <postUrl> --limit N` for the engaged audience. A post too fresh
   to have reactions yields nothing here — expected, not a failure.
3. **Qualify** — score the reactors against `knowledge/icp.md`. Keep only the
   shortlist worth a human's attention; a viral post's reactions are mostly noise.
4. **Enrich** — shortlist only: `leads get-profile <profileUrl>`. It runs the three
   profile calls + the company and writes the lead to the record store.

## Tools

Run via Bash; each prints JSON on stdout.

| Command                              | Returns                                     |
| ------------------------------------ | ------------------------------------------- |
| `leads discover "<topic>" --limit N` | post URLs                                   |
| `leads post <postUrl>`               | post content + author                       |
| `leads reactors <postUrl> --limit N` | reactors (name + profile link)              |
| `leads get-profile <profileUrl>`     | full lead (profile/exp/edu/company), stored |

## Rules

- Keep concurrency modest — a wide browser fan-out is its own failure mode.
- Deliver per lead: the verdict **and the one signal that earned it**.
- The scripts are `loggedIn` — a LinkedIn session must be exposed via
  `reduck local --cookies`. The record store is chosen by `LEADS_ADAPTER`.
