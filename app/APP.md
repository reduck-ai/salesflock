# app

Two surfaces on one SvelteKit app, behind one auth gate, reading Notion:

- **`/`** — the review surface for Decisions awaiting human judgment (shadcn-svelte,
  one data source).
- **`/write`** — the **Writer**: long-form drafts (blogs, posts) listed, then edited one
  at a time in CodeMirror, saved to a Notion database where the row is the metadata and
  the page BODY is the prose. ⌘S saves, and so does a 15s heartbeat when the draft is
  dirty. Markdown both ways through `$core/stores/notion.codec` (`bodyOf` reads,
  `blocksOf` writes), so the editor and the page agree on what a heading is.

Both surfaces share the inline-autocomplete stack: `lib/autocomplete/engine.ts` (one
debounce/abort/supersede race, plus the persisted on/off preference that ⇧⇥ toggles) and
`/api/complete`, which grounds a suggestion either in a Decision (its Prompt body + frozen
evidence, fetched from Notion) or in the Writer's declared voice (below). Each surface only
paints — a ghost overlay on the review form's textareas, a widget decoration in CodeMirror.

Deployed on Vercel; CI/CD is Vercel's Git integration — there is nothing else to
configure.

## Auth modes

The gate is a seam (`src/lib/server/auth/`): an **authenticator** (how a visitor is
established) times a **policy** (who is allowed). `AUTH_PROVIDER` picks the
authenticator — default `google`, so the app ships gated. Switching mode is an env
change, never a code change.

| Mode            | `AUTH_PROVIDER`    | Set               | Who gets in                               |
| --------------- | ------------------ | ----------------- | ----------------------------------------- |
| Personal Google | `google` (default) | `ALLOWED_EMAILS`  | emails on the list                        |
| Workspace       | `google`           | `ALLOWED_DOMAINS` | anyone `@your-domain`                     |
| Secret link     | `secret-link`      | `ACCESS_KEY`      | anyone with the link `/?key=<ACCESS_KEY>` |

Adding an authenticator (e.g. WorkOS) is one new file implementing the `Auth`
interface in `auth/types.ts` plus a branch in `auth/index.ts` — nothing else moves.

## Secrets

All configuration is the variables in `.env.example`. `AUTH_SECRET` is always
required (it signs sessions, including the secret-link cookie). The rest depend on
the mode above.

1. **Google OAuth client** (`google` mode) — [console.cloud.google.com](https://console.cloud.google.com/apis/credentials)
   → Create credentials → OAuth client ID → Web application. Authorized redirect URIs:
    - `http://localhost:5173/auth/callback/google`
    - `https://<your-app>.vercel.app/auth/callback/google`

    The client ID/secret are `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`. Then set exactly
    one policy: `ALLOWED_EMAILS` (comma-separated addresses — the invite list) **or**
    `ALLOWED_DOMAINS` (comma-separated domains, the Workspace case). The gate fails
    closed if neither is set.

2. **`ACCESS_KEY`** (`secret-link` mode) — any long random string; the link is
   `/?key=<ACCESS_KEY>`. No Google, no policy: holding the key is the authorization.
3. **`AUTH_SECRET`** — `npx auth secret` (or any long random string).
4. **Notion** — [notion.so/profile/integrations](https://www.notion.so/profile/integrations)
   → new internal integration → `NOTION_TOKEN`. Share the Decisions database with
   it (⋯ → Connections), and put its data-source id in `NOTION_DECISIONS_DS`.
   The page renders whatever properties the data source has, so a fork can point
   it at any database.
5. **`NOTION_WRITER_DS`** (the `/write` surface) — the data-source id of the database
   holding your drafts; it needs a title property, and a `Status` select if you want the
   list's tabs. Share that database with the same integration too — an unshared one 404s
   with "Make sure the relevant pages and databases are shared with your integration",
   which is the one setup mistake this surface can make.

6. **`SALESFLOCK_MODELS`** — the table ids of the AGENTS' own databases, as one JSON object:
   `{"reddit-engage":{"RedditThreads":"…","RedditBacklog":"…","Decisions":"…"}}`. It is the
   contents of `salesflock/models.local.json`, which `sflock init` writes (src/models.ts); the CLI
   loads that file, and the app — which has no working directory to find it in — takes the variable.
   `NOTION_DECISIONS_DS` above stays separate and is still required: the queue reads EVERY agent's
   decisions from one table, so it cannot resolve that id per row the way it resolves an agent.
   This one is for the opposite case — the single path that reaches an agent's OWN tables, a
   refusal calling `config.drop` to close the outreach. Without it the note is still saved and the
   request then fails naming the missing id, which is recoverable (set it, save again) but visible
   to whoever clicked.

`.env.example` lists every variable; add `AUTH_PROVIDER`, `ALLOWED_DOMAINS`, and
`ACCESS_KEY` there alongside the originals if they are not yet present.

## Run locally

```sh
cp .env.example .env.local   # fill it in
npm install
npm run dev
```

The write-back needs the Notion integration's "Update content" capability plus four
properties on the Decisions database. Three are the human's WORKING COPY — `Draft output`,
`Feedback`, `Final reasoning` (all rich text) — written together by a Save, so a row reopens
exactly as it was left. The fourth, `Final output`, is the decision. The committed output IS
the decision, and agreement is *derived* (`Final output ≡ Output`) — there is no stored verdict
column. A commit writes `Final output` and CLEARS `Draft output`: the working
copy has become the decision, and two columns must never both claim to be the human's last word.

**A row is pending iff the human has said nothing**, and there are two ways to say something —
which column carries it is what says which way it went. A committed output is a Confirm: it was
posted. A **note is a rejection**: it was not. So the queue's cut reads both columns (`SAID` in
`server/notion.ts`), `record` derives the same fact from the same emptiness rather than taking a
declared intent (a client that declared one could send a note-less reject), and the card's second
button relabels **Note → Reject** the moment the note has words, so ⌘S states its consequence
before you press it. A rejection is REVERSIBLE — the note *is* the marker, so clearing it returns
the row to the queue — which is what makes one key carrying two outcomes fair next to a Confirm
that posts to the world and cannot be undone.
Since a decision also moves the linked pipeline entity, "Update content" on that database is needed
too. Which Status each committed output moves it to is the agent's config (`config.prompts`,
imported via the `$agents` alias), not app code.

**A CONFIRM BEGINS AS A SAVE.** `record` writes the working copy — minus the note, see below —
before the gates and before the act, and only then attempts the decision. A draft is not a decision
and has none of its atomicity requirement: what must never half-happen is the DEED, which is still
guaranteed (nothing speaks to the world until every gate passes, and `Final output` lands only once
it has). The human's WORDS have the opposite requirement — they cost human effort, they claim no
verdict, and losing them because a device was asleep is the one outcome with no upside. It used to
be exactly that: the card unmounts at the click and its state was the only copy, so a failed act
took the rewrite with it. The NOTE stays out of that early write, and that asymmetry is the point —
`Feedback` is a verdict channel, so pre-saving it would make a failed Confirm read as a *rejection*
in the Past tab and the learn worklist, a failure inventing a decision.

Those four columns are one precedence, resolved once in `cards/decision.ts`, and it is what a card
opens on: **`Final output ?? Draft output ?? Output`** — the human's latest word if they have one,
else the judge's. Each rung earns its place. Without the first, reopening a decided row shows the
model's proposal rather than what was committed, so a re-confirm would silently post text the human
had already replaced. Without the second, a Save kept the note and the reasoning but threw away the
words — which made committing the only way to keep an edit. `proposed` carries the judge's own
Output alongside, because an overturn is precisely the two differing.

## A Confirm can also DO the thing — and so can a refusal

The symmetry is the agent's own declaration: `PromptSpec.act` is what approving performs, and
`AgentConfig.drop` is what refusing performs (close the outreach the draft opened). Both were
declared from the start; only `act` was reachable from a click, so the app could approve and never
refuse — `sflock learn` was the sole caller of the other half. Saving a note now runs `drop`, and
the Decision row is deliberately **not** archived: it stays as the audit trail and as the frozen
evidence `sflock learn` cuts a ground-truth case from. That is the hand-off — the row leaves this
queue and lands in the learn worklist (`sflock decisions list --feedback`, where it is flagged
`rejected`), which is the second stage and the one that touches git.


An agent may declare `act` beside `resolve` (`PromptSpec`, `$core/stores`): what committing
this decision performs in the world — post the reply, send the message. `record` runs it
after every gate and before any write, and merges its result (a permalink, a timestamp) into
the same patch as the status it earns.

That placement is the whole design. Approving in one pass and performing in another gives a
decision two truths — approved, and done — and a window between them that something else has
to model, watch and reconcile. Here there is no window: a failure throws (surfaced to the
reviewer with its reason, as a 502, because SvelteKit hides internal messages in production),
persists nothing, and leaves the row in the queue to confirm again. That retry is safe because
the act guards on its own evidence in the world — reddit-engage's returns null when the
outreach already has a `Comment URL` — never on a status. Its result lands even when the
ladder refuses the status move: a permalink is a fact that already happened.

An act reaches a browser through `$core/clients/reduck`, which runs over the MCP server's REST
API — the one transport, here and in the runtime alike, so this is no longer a serverless special
case. **`REDUCK_API_KEY`** is the only variable it needs, and without it the client throws naming
the variable (it used to shell a CLI that does not exist in a function, and the failure then read
"Session expired") — but a throw is the *second* line of defence now, because that key is a
precondition of the deployment, not an outcome of the run: it is constant for a session and
knowable with no I/O, so `contractOf` resolves it with the rest of the card's contract
(`$core/clients/reduck` `configured()`) and a Confirm that could not possibly succeed is never
offered. It arrives as `blocked`, one sentence, and the card merges it into the single string that
already greys Confirm out for a schema violation (`whyInert`) — no new affordance. Save and Note
stay live throughout: neither needs a browser, so a blocked Confirm never traps a reviewer.
WHICH browser — i.e. which signed-in identity the site sees —
is the agent's to declare and it passes it per call (reddit-engage keeps reading and writing on
separate accounts, `DEVICES` in its `config.ts`), so no env var decides who acts. A browser run
takes tens of seconds, so `api/decide` sets `maxDuration` and the card shows its existing
committing skeleton for the whole round-trip.

## The Writer's voice (`/write` autocomplete)

The two things that shape a suggestion are **local files**, not Notion rows and not env — a
Decision's grounding is the frozen `Input` plus its prompt file (`server/prompts.ts`, bundled at
build time), but the Writer's is *declared*:

- **`src/lib/writer/voice.md`** — the system prompt: who is writing and how. The one place.
- **`src/lib/writer/examples.yaml`** — which of my own pieces are canonical samples: a pointer
  list (`file:` + a `note:` naming the register, which the model sees). The prose sits in
  `src/lib/writer/corpus/*.md`, verbatim as published.

`src/lib/server/voice.ts` assembles them. Both are `?raw` imports and the corpus is one eager
`import.meta.glob`, so everything resolves at **build** time — on Vercel the completion runs in a
serverless function that does not have this repo's loose files, so an `fs` read would work in dev
and 404 in production. A `file:` the corpus lacks throws at module load, naming both sides.

Order is the design: voice → samples → the document's title → the Task → the caret. Everything
before the title is byte-identical across every request, so it is one long stable prefix for
Gemini's implicit cache (~1.5k tokens with three samples; watch `cached=` in `complete.ts`'s log
line). Adding samples is therefore cheap in latency but not free in tokens — this is a voice
sample, not an archive.

## The Writer's live channel (`/write`)

One document has one wire — `routes/api/doc/[id]`, all three of its jobs, because they are
one payload:

- **`PUT`** saves the whole document (title + body markdown) to the Notion page, then
  **publishes** what it saved. `sflock docs push` calls this exact endpoint, so an agent
  writes through the same sink the editor does: one write path, and the live fan-out is free
  rather than a second mechanism. An omitted `title` leaves the page's Name alone.
- **`GET`** is the same URL twice, discriminated by `Accept` (which `EventSource` sets for
  free): JSON is the editor's `Sync ↓` (also how an edit made in Notion is picked up),
  `text/event-stream` is the live subscription. Same loader, same payload — so the editor has
  **one** apply path for both triggers.
- **Applying** is a single CodeMirror transaction replacing the whole text, which makes an
  incoming version one ⌘Z away. That undo is the safety net, and why a push needs no
  Apply/Discard banner. The saver's own `x-writer-client` token rides on the event so a tab
  ignores the echo of its own save (otherwise every autosave would cost the writer their caret).

Two things are deliberately **dev-only** (`$app/environment`'s `dev`): the push gate — a
request may write with `x-writer-push: local` instead of a session — and the editor's
`EventSource`. So there is no key to manage, the knob cannot be reached on the deployed app,
and production never holds a serverless invocation open for an event that can't arrive there.
`lib/server/live.ts` is an in-process `Map` of subscribers for the same reason: publisher and
subscriber are the same local dev server by construction. A missed event loses nothing — the
document is on the Notion page regardless, and `Sync ↓` re-reads it.

## Deploy

```sh
npx vercel link        # from this directory — creates the Vercel project
npx vercel env add …   # the six variables, or paste them in the dashboard
npx vercel git connect # binds the GitHub repo → push-to-deploy
```

If the app lives in a subdirectory of the repo (as here), set the project's
**Root Directory** to it in Vercel → Settings. The app shares the parent repo's
core rather than re-implementing it (the `$core` alias in `vite.config.ts` →
`../src`; first user: the Notion codec), so leave **Include source files outside
of the Root Directory** enabled (the default). From then on every push deploys a
preview and every merge to the default branch deploys production — that is the
whole CI/CD story.

Two one-time toggles:

- `vercel git connect` needs Vercel's [GitHub App](https://github.com/apps/vercel)
  installed on the repo's org (scope it to just this repo).
- Vercel → Settings → Deployment Protection → turn **Vercel Authentication off**:
  the app's own allowlist is the gate; Vercel's SSO wall would block your team.
