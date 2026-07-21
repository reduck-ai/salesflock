# _template — a blank agent

A copy-me scaffold for a new agent under `agents/`. Everything here ships as `*.example`
so `tsc` ignores it (only real `.ts` under `agents/` compiles — see `tsconfig.json`
`include`). Instantiating an agent is: copy this folder, drop the `.example` suffixes,
fill them in, register the binary.

An agent is thin. The shared engine (`src/`) does the heavy lifting — the store seam
(`src/stores/`), the judgment loop (`src/decide.ts`), the reduck runner
(`src/clients/reduck.ts`). This folder is just the wiring: which store + tables
(`config.ts`), which source scripts compose into records (`tools.ts`), the CLI surface
(`cli.ts`), and the identity you judge against (`knowledge/`).

## The canonical funnel

`search → enrich → qualify → engage`, each stage monotonic and idempotent on ONE identity
key (see `linkedin-leads` / `former-rpa-pms`). A stage no-ops once the entity has advanced
past its target; a judgment persists exactly one Decision, gated by the Prompt's Output
schema, and moves the entity to the human review gate.

## Instantiate

1. `cp -r agents/_template agents/<id>` and rename `<id>` throughout.
2. `mv` each `*.example` → drop the suffix; fill in the TODOs.
3. Register the binary in `package.json` `bin`: `"<binary>": "./dist/agents/<id>/cli.js"`.
4. Fill `config.ts` model ids, then `sflock pull --agent <id>` to generate `schema/*.ts`.
5. Write `knowledge/company.md` + `knowledge/icp.md` (the identity the judge grounds on).
6. `pnpm build` && run `<binary> --help`.

## Source seam — the one thing not yet shared

`src/decide.ts` is agent-agnostic **only across LinkedIn agents today**: it imports
`profileUrl` from `src/clients/lk`, resolves a person as `linkedin.com/in/<publicId>`, and
keys `People`/`Leads` on `"LinkedIn URL"`. A NON-LinkedIn source (e.g. x.com) must first
lift that identity resolution into a seam — the same way `renderEvidence` and
`projectInput` are already injected into `createDecider`. See the `## Brainstorm` note the
instantiator leaves for the new source's client (`src/clients/<source>/`) and evidence
renderer (`src/<source>/`).
