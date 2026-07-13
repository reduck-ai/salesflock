# app

A one-page review surface for Decisions awaiting human judgment. SvelteKit +
shadcn-svelte, gated by Google sign-in against an email allowlist, reading one
Notion data source. Deployed on Vercel; CI/CD is Vercel's Git integration —
there is nothing else to configure.

## Secrets

All configuration is the six variables in `.env.example`.

1. **Google OAuth client** — [console.cloud.google.com](https://console.cloud.google.com/apis/credentials)
   → Create credentials → OAuth client ID → Web application. Authorized redirect URIs:
   - `http://localhost:5173/auth/callback/google`
   - `https://<your-app>.vercel.app/auth/callback/google`

   The client ID/secret are `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`.
2. **`AUTH_SECRET`** — `npx auth secret` (or any long random string).
3. **`ALLOWED_EMAILS`** — comma-separated Google account emails. This *is* the
   invite list: adding a teammate is adding their address and redeploying.
4. **Notion** — [notion.so/profile/integrations](https://www.notion.so/profile/integrations)
   → new internal integration → `NOTION_TOKEN`. Share the Decisions database with
   it (⋯ → Connections), and put its data-source id in `NOTION_DECISIONS_DS`.
   The page renders whatever properties the data source has, so a fork can point
   it at any database.

## Run locally

```sh
cp .env.example .env.local   # fill it in
npm install
npm run dev
```

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
