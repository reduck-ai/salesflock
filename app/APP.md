# app

A one-page review surface for Decisions awaiting human judgment. SvelteKit +
shadcn-svelte, gated by a pluggable auth module, reading one Notion data source.
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

`.env.example` lists every variable; add `AUTH_PROVIDER`, `ALLOWED_DOMAINS`, and
`ACCESS_KEY` there alongside the originals if they are not yet present.

## Run locally

```sh
cp .env.example .env.local   # fill it in
npm install
npm run dev
```

The verdict write-back needs the Notion integration's "Update content" capability plus
two properties on the Decisions database — `Human verdict` (select) and `Feedback`
(rich text) — and, since a verdict also moves the linked Lead, "Update content" on the
Leads database too.

## Deploy

```sh
npx vercel link        # from this directory — creates the Vercel project
npx vercel env add …   # the six variables, or paste them in the dashboard
npx vercel git connect # binds the GitHub repo → push-to-deploy
```

If the app lives in a subdirectory of the repo (as here), set the project's
**Root Directory** to it in Vercel → Settings. From then on every push deploys a
preview and every merge to the default branch deploys production — that is the
whole CI/CD story.

Two one-time toggles:

- `vercel git connect` needs Vercel's [GitHub App](https://github.com/apps/vercel)
  installed on the repo's org (scope it to just this repo).
- Vercel → Settings → Deployment Protection → turn **Vercel Authentication off**:
  the app's own allowlist is the gate; Vercel's SSO wall would block your team.
