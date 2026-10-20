# Deployment

**Status: prepared, not deployed.** Nothing in this repository has been deployed, and no hosting account,
platform configuration file or paid service has been created. This document says what a deployment needs, so
that it can be done later. The assignment requires a public deployment with frontend and backend reachable,
environment variables handled securely and documented, and says free tiers are expected. It names no platform.

## What has to run

| Part     | What it is                                                | Needs                                                                            |
| -------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Web      | Next.js 16 app (`apps/web`)                               | Node 20.19+ server (`next start`) or any host that runs a Next.js build          |
| API      | Express 5 (`apps/api`), started with `tsx src/index.ts`   | A long-running Node process, **one instance**, reachable over https              |
| Database | MongoDB 7+ (tested against `mongo:8`)                     | A MongoDB the API can reach, with a user and password                            |
| Model    | An LLM provider (`LLM_*` variables, Gemini is the tested) | An API key. Generation makes live requests; the free quota is small (see README) |

Constraints that decide where this can run:

- **One API instance.** Generation and regeneration jobs run inside the API process, and the rate limits are
  in memory. Two instances would not share them, and a restart marks running jobs as failed (the API does this
  on startup). Hosts that scale to zero or restart often make jobs fail more often.
- **Long requests are not used.** Jobs are polled, so no host timeout applies to them, but a job needs the
  process to stay alive for up to a few minutes.
- **The API needs its dev dependencies installed.** `tsx` is a root devDependency and is the runtime of
  `pnpm --filter @trao/api start`. Install with `pnpm install --frozen-lockfile` (not `--prod`). Moving `tsx`
  to a production dependency, or compiling the API, would be a change to the repository and is not done.
- **https is required** for the browser. The session cookie is `Secure` in production.

## Recommended approach (not applied)

No platform file is committed. A workable arrangement, which has **not** been tried here:

- Web: a Node or Next.js capable host.
- API: a small always-on web service host that runs Node and one process.
- MongoDB: a managed MongoDB (for example MongoDB Atlas) with a database user and an IP/network rule.

Before choosing, check each provider's current terms. What to look for, because it was **not** verified here:

- Free tiers often sleep after inactivity (the first request is slow, and jobs running at that moment are
  lost), have monthly hour limits, or require a card. Do not assume a free tier covers an always-on API.
- A free managed database has storage limits and may pause. The app needs the database to be reachable
  whenever the API starts (it creates its indexes on startup).
- The model provider's free quota is the real limit on generation (the README notes about 20 requests a day
  observed for one free model, about two cases).

If the web app and API are on **sibling subdomains of one registrable domain** (for example
`app.example.com` and `api.example.com`), the default `COOKIE_SAMESITE=lax` works. If they are on unrelated
domains (two different `*.hosting-provider.app` names are different sites), set `COOKIE_SAMESITE=none`, which
needs production mode and relies on the strict `Origin` check for CSRF protection.

## Environment variables

Every variable, with a placeholder, is in [`.env.example`](../.env.example). Put real values only in the
host's secret store. **Never commit them, and never put a secret in `NEXT_PUBLIC_*`.**

### Web (read at build time)

| Variable              | Purpose                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL` | Public **https** address of the API, for example `https://api.example.com`. Baked into the bundle when it is built. |

It is public by design (every browser sees it). It must be set **when the web app is built**; changing it on
the running host does nothing until you rebuild. See "The API address" below.

### API (read at start)

| Variable                                                     | Purpose and production value                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                   | `production`. Turns on Secure `__Host-` cookies and refuses unsafe settings.                                        |
| `PORT`                                                       | Port to listen on (many hosts provide it).                                                                          |
| `WEB_ORIGIN`                                                 | The exact origin of the web app, `https://app.example.com`. The only origin allowed by CORS and the CSRF check.     |
| `MONGODB_URI`                                                | Connection string with its own credentials. Secret.                                                                 |
| `SESSION_SECRET`                                             | At least 32 random characters. Secret. Changing it signs everyone out. The API refuses to start with a weak one.    |
| `COOKIE_SAMESITE`                                            | `lax` for sibling subdomains, `none` for different sites (see above).                                               |
| `TRUST_PROXY`                                                | Number of reverse-proxy hops in front of the API (usually `1` on a platform proxy). Wrong values allow IP spoofing. |
| `ALLOW_PRIVATE_HOSTS`                                        | Must be `false`. The server refuses to start with `true` in production.                                             |
| `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY` or `GROQ_API_KEY` | The model to use and its key. Secret. See `.env.example` for the exact names and defaults.                          |
| `LOG_LEVEL`, rate-limit and job variables                    | Optional tuning; defaults are in `.env.example`.                                                                    |

Generate a secret locally with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.

## The API address and the localhost fallback

Locally an unset `NEXT_PUBLIC_API_URL` means `http://localhost:4000`. That default is only used while the page
is itself served from `localhost` (or another loopback address). On any other host the web app refuses to call
the API when the address is unset, uses `http`, points at localhost or contains credentials, and shows a clear
"not set up correctly" message instead of calling anything.

A deployment should build with:

```bash
NEXT_PUBLIC_API_URL=https://api.example.com pnpm build:production
```

`build:production` first runs `apps/web/scripts/check-production-env.ts`, which fails the build (exit 1) if the
address is unset, not https, local or has credentials, and then builds the web app and type-checks the API. A
plain `pnpm build` stays permissive for local use and CI and only prints a warning. Both behaviours have tests
(`apps/web/src/lib/api/base-url.test.ts`). The CI workflow runs `build:production` with the placeholder
`https://api.example.com`.

## Steps (when you deploy)

1. Create the MongoDB database and a user; keep the connection string secret.
2. Deploy the API: install with `pnpm install --frozen-lockfile`, start with `pnpm --filter @trao/api start`,
   set the API variables above, and run exactly one instance. Check `GET /health` (process is up) and
   `GET /ready` (database reachable).
3. Note the API's public https address.
4. Build and deploy the web app with `NEXT_PUBLIC_API_URL` set to that address, using `pnpm build:production`,
   and start it with `pnpm --filter @trao/web start` (or the host's Next.js runtime).
5. Set `WEB_ORIGIN` on the API to the web app's origin and restart the API.
6. In a real browser: register, create a kit, check that the session cookie persists across a reload. This
   cookie/CORS flow is **not tested in a real browser** anywhere in this repository.

## Checklist

- [ ] `NEXT_PUBLIC_API_URL` is an https address and the web app was built with `pnpm build:production`
- [ ] `WEB_ORIGIN` equals the web origin exactly (scheme, host, port; no trailing slash)
- [ ] `SESSION_SECRET` is random, 32+ characters and stored only in the secret store
- [ ] `ALLOW_PRIVATE_HOSTS=false`, `NODE_ENV=production`
- [ ] `TRUST_PROXY` matches the number of proxies in front of the API
- [ ] `COOKIE_SAMESITE` suits the domains
- [ ] One API instance; `/ready` returns ok
- [ ] No real keys in the repository, the CI logs or the web build

## Not verified

Not deployed; no platform tried; free-tier behaviour unknown; cookies and CORS across the two real origins
never exercised in a browser; real-provider generation time on the deployed API unmeasured; Node 20.19 not
tested (developed on 24, CI on 22).
