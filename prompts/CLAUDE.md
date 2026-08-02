# prompts

This folder is the **pool**: prose several prompts share, one file per section, flat — the file NAME
is the identity (`company`, `reddit-context`, `reddit-reply-law`). The prompts themselves live beside
their agent, one folder each:

```
prompts/<name>.md                          the pool — shared sections, authored ONCE here
agents/<id>/prompts/<key>/
  PROMPT.md          the instructions the model reads (pure prose, no frontmatter)
  input.json         what the judgment is shown      ┐ JSON Schema, draft-07
  output.json        what it must return             ┘ (a bare `new Ajv()` — do not tag 2020-12)
  ground_truth.yaml  the corpus it is calibrated against (only for a graded prompt)
```

`<key>` is the key in that agent's `config.ts` `prompts` — the two must match, both ways, and a test
says so. Git is the version: a diff is the review, `git log -S` the history, a commit the publish.

## The one rule

A shared section is **inlined** into each prompt, between markers:

```markdown
<!-- shared:company -->
Reduck makes it trivial to …
<!-- /shared:company -->
```

So a `PROMPT.md` is the whole prompt — nothing resolves at read time, and what you see is what the
model gets (minus the marker lines). The text between markers is a **generated copy**: the pool file
is the source. Edit it there and re-inline; editing it inside a `PROMPT.md` forks it away from the
pool and from every other prompt that carries it.

You cannot get this wrong quietly — `sflock prompts --check` and `npm test` both fail on a copy that
no longer matches its source, naming the prompt and the section.

## How to edit

**Prompts are read from these files at runtime — `npm run build` is only for TypeScript.** Edit a
prompt and the next `rdt`/`sflock` run already uses it.

| you want to change | do |
| --- | --- |
| one prompt's own prose | edit its `PROMPT.md`, outside the markers |
| prose several prompts share | edit `prompts/<name>.md`, then `sflock prompts` to re-inline it everywhere |
| what a judgment is shown / must return | edit `input.json` / `output.json` |
| add a shared section | write `prompts/<name>.md`, paste the two marker lines where it belongs (top level, never indented), then `sflock prompts` to fill it in |
| add a prompt | `mkdir agents/<id>/prompts/<key>/`, write the three files, add the `<key>` to `config.ts` |

Then: **`sflock eval` → commit.** An edit nobody scored is a guess.

## Tooling

Neither binary is on `PATH`; from `salesflock/` they are `node dist/src/cli.js …` (`sflock`) and
`node dist/agents/<id>/cli.js …` (`rdt`).

    sflock prompts              re-inline every shared section from the pool (the only writer)
    sflock prompts --check      report drift instead, exit 1 — also prints each prompt's fingerprint
    npm test                    the same check, plus: schemas compile, config ↔ folders agree,
                                no marker reaches the model, no pool file is unused

    sflock eval qualify --agent <id> [candidate.md]   label vs judgment — no model scores it, so it
                                is cheap and offline; run it on every edit
    sflock eval judge  --agent <id> [candidate.md]    does the SCORER agree with your reviews
    sflock eval reply  --agent <id> [candidate.md]    does the DRAFTER satisfy the scorer

A **candidate** is just a copy of a `PROMPT.md`: `cp …/reply/PROMPT.md /tmp/c.md`, edit, score it,
and if it wins, copy it back. Markers in or already stripped — either is read the same way. Every
eval refuses to run at all while anything has drifted, because scoring text nobody committed proves
nothing.

## Worth knowing

- **The judge never sees a marker.** The loader drops those lines; the file keeps them, which is what
  makes it both authorable and checkable.
- **A fingerprint covers instructions AND both schemas.** Changing any of the three means past
  Decisions read `stale` in `sflock decisions show` — correct, not a fault: they were judged under
  other words. A Decision stores only `Kind` (which judgment) and that hash (which wording); the rest
  is here, at that hash.
- **Markers must sit at the top level.** An indented one reads fine but is refused on re-inline —
  rebuilding the structure around it could move shared prose out of the block that framed it.
- **Flash is not run-stable at temperature 0**, so one green eval proves little. Run a candidate
  twice before believing it (measured: 46/46 then 45/46 on the identical corpus).
