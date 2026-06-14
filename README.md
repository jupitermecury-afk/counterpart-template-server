# Counterpart — Self-Hosted Template

This folder is a complete, self-contained deployment of Counterpart for **one
organization**. Deploy it once and your company pays for its own Anthropic
(and optional Tavily) usage — nothing routes through anyone else's account.

It contains:

- **`server.js` / `package.json`** — a small Express server that talks to the
  Anthropic API on your behalf (so your API key never sits in the browser).
- **`frontend/`** — the four Counterpart web apps:
  - `index.html` — the main seat app (text)
  - `voice.html` — multilingual voice-first seat app
  - `operator.html` — admin console for issuing/managing seat keys
  - `partner.html` — admin console for issuing/managing partner cohort keys

You only need `operator.html` and/or `partner.html` if you're issuing seats to
other people. A single person can just use `index.html` or `voice.html`
directly with one of the built-in access keys.

---

## Quick deploy

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template/REPLACE_WITH_YOUR_TEMPLATE_ID)

This button deploys the server only (`server.js` + `package.json` +
`railway.json`). After deploying, you still need to do steps 2–4 below
(configure the front end and put it on Netlify).

> **One-time setup for you (the maintainer):** the button above is a
> placeholder. To make it real:
> 1. Push this folder to a GitHub repo and deploy it once yourself by
>    following "1. Deploy the server" below — this is your reference
>    deployment.
> 2. In the Railway dashboard, open that project and look for
>    **Settings → "Create Template"** (or the template icon in the project
>    header). Railway will detect `railway.json`, walk you through marking
>    `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`, and `CLIENT_SECRET` as
>    user-supplied variables (with the descriptions from `.env.example`), and
>    give you a template URL like `https://railway.app/new/template/abc123`.
> 3. Replace `REPLACE_WITH_YOUR_TEMPLATE_ID` above with that URL. Now anyone
>    who clicks the button deploys their **own** server with their **own**
>    keys — none of it touches your account.

If you'd rather not deal with templates yet, just follow the manual steps
below — they take about 10 minutes.

---

## 1. Deploy the server (Railway)

1. Create a free [Railway](https://railway.app) account if you don't have one.
2. Push this folder (or just `server.js`, `package.json`, `.gitignore`) to a
   new GitHub repo.
3. In Railway: **New Project → Deploy from GitHub repo** → pick that repo.
4. Once it's created, open the project → **Variables** tab and add:

   | Variable | Required? | Value |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | Yes | Your key from [console.anthropic.com](https://console.anthropic.com) |
   | `TAVILY_API_KEY` | Optional | Your key from [tavily.com](https://tavily.com) — enables live web search |
   | `CLIENT_SECRET` | Optional | Any random string — see "Optional extra protection" below |

5. Railway will build and deploy automatically. Once it's live, open the
   **Settings → Networking** tab and click **Generate Domain** to get a public
   URL, e.g. `https://my-company-counterpart.up.railway.app`.
6. Visit that URL in a browser — you should see
   `{"status":"ok","service":"counterpart-server"}`. That confirms it's running.

Every time you push a new commit to GitHub, Railway redeploys automatically
(usually within ~90 seconds).

### Optional extra protection: `CLIENT_SECRET`

By default, anyone who discovers your server URL could send it requests and
use up your Anthropic credits. Setting `CLIENT_SECRET` to a random string
closes that off — the server then rejects any request that doesn't include a
matching `X-Client-Secret` header. If you set this, you must also set the same
value in `CLIENT_SECRET` inside `frontend/index.html` and
`frontend/voice.html` (step 3 below). If you leave it blank, everything still
works — you're just trusting that your server URL stays private.

---

## 2. Configure the front end

Open `frontend/index.html` and `frontend/voice.html`. Near the top of the
`<script>` block, in the `CONFIG` section, you'll find:

```js
const SERVER = "https://YOUR-RAILWAY-APP.up.railway.app";
const CLIENT_SECRET = "";
```

- Replace `SERVER` with the Railway URL from step 1.5.
- If you set `CLIENT_SECRET` on the server, put the **same value** here too.
  Otherwise leave it as `""`.

---

## 3. Deploy the front end (Netlify)

1. Create a free [Netlify](https://netlify.com) account if needed.
2. Push the `frontend/` folder to a GitHub repo (can be the same repo or a
   separate one — your choice).
3. In Netlify: **Add new site → Import an existing project** → pick the repo.
4. Leave the build command empty and set the publish directory to `frontend`
   (or `.` if `frontend/` is the repo root).
5. Deploy. Netlify gives you a URL like `https://my-company-counterpart.netlify.app`.

That's it — your team can now visit that URL.

---

## 4. Managing access keys (your yearly "front-end license")

`index.html` and `voice.html` ship with four built-in demo keys
(`ESSENCE-2026`, `BAAFOUR-2026`, `BENJI-2026`, `EINSTJII-2026`), each valid
**2026-06-01 through 2027-06-01**. These are defined near the top of each
file in the `ACCESS_KEYS` array — edit the dates there to set your own
renewal window, or remove keys you don't want active.

For issuing keys to multiple people/teams over time, use `operator.html`
(per-seat keys) and `partner.html` (per-cohort keys with language/voice
settings). Both write to a shared `cp_key_registry_v1` browser-local-storage
registry that `index.html`/`voice.html` read at login. Each issued key has its
own `validFrom`/`validTo` dates and a `revoked` flag — set `validTo` to one
year out and update it annually to "renew" a key, or flip `revoked: true` (via
the admin console) to cut someone off immediately.

**Note:** because the registry lives in browser local storage, it's
per-browser/per-device, not a shared database. For a small team sharing one
admin's browser this is fine; if you need centrally-managed licensing across
many devices, that's what the managed (Option A) deployment is for.

---

## Local testing (optional)

```bash
npm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY
npm start
```

Then open `frontend/index.html` directly in a browser, with `SERVER` in its
CONFIG section pointed at `http://localhost:3000`.
