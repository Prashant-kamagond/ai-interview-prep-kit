# Deployment

**Status: deployed to production on Vercel** (https://ai-interview-prep-kit-green.vercel.app/, 2026-10-21), with the database on a MongoDB Atlas
free cluster. The Vercel Services configuration in `vercel.json` built and runs; see "Vercel" below for what
was verified and the remaining limits. This document says what a deployment needs, so that it can be done later. The assignment requires a public deployment with frontend and backend reachable,
environment variables handled securely and documented, and says free tiers are expected. It names no platform.

## Vercel (prepared, not deployed)

The repository is prepared for **Vercel Services**: one Vercel project that builds the Next.js app and the
Express API as two services on one domain. Nothing has been deployed, no project was created, and the setup
below has **not** been run on Vercel. The syntax follows Vercel's Services documentation (read 2026-10-20,
a beta feature); the first deployment is what confirms it works.

### What was added

| File                                                 | Purpose                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `vercel.json`                                        | The two services, the public routes, and the `/api` prefix strip                 |
| `apps/api/src/server.ts`                             | The API as a Vercel Function: exports the Express app, nothing listens on a port |
| `apps/api/src/serverless.ts`, `serverless-limits.ts` | Lazy database preparation, keep-alive request, stale-job limit                   |
| `apps/web/src/lib/api/base-url.ts`                   | `NEXT_PUBLIC_API_URL` may be the same-origin path `/api`                         |

`make dev` and local development are unchanged: they use `apps/api/src/index.ts`, which listens on a port.

### Services and routes

| Service | Root        | Framework | Public routes              |
| ------- | ----------- | --------- | -------------------------- |
| `web`   | `apps/web/` | Next.js   | everything except `/api/*` |
| `api`   | `apps/api/` | Express   | `/api/*`                   |

- A service is public only through the top-level `rewrites`: `/api/(.*)` goes to `api` first, then `/(.*)` goes
  to `web`. Order matters.
- Vercel passes a service the **original** path (`/api/kits`). The Express routes have no `/api` prefix
  (`/kits`, `/auth/login`, `/generation-jobs`, `/health`), so the API service has a `request.path` transform
  that sets the path to `/$1`. Tests (`scripts/vercel-config.test.ts`, `apps/api/src/serverless.integration.test.ts`)
  check that every public path maps to a real Express route.
- **No bindings are declared.** A binding lets one service call another from server code. Here the browser calls
  the API through the public `/api` route and the web app never calls the API server-side (every page is a
  client component), so a binding would grant nothing.
- Public URLs: `https://<domain>/api/health`, `/api/auth/*`, `/api/kits*`, `/api/generation-jobs*`.
- Because both services share one origin, the session cookie stays first-party (`__Host-sid`, Secure, HttpOnly,
  SameSite=Lax) and no CORS is involved. The CSRF check still requires `Origin` to equal `WEB_ORIGIN`.

### Environment variable names

Set these in the Vercel project settings (never in the repository). Values are secrets unless noted.

**API service**

| Name                            | Value / purpose                                                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                      | `production` (Vercel normally sets it). Turns on Secure `__Host-` cookies and checks                                                                                                           |
| `WEB_ORIGIN`                    | The exact public origin, `https://<your-domain>` (not a secret). Required for writes                                                                                                           |
| `MONGODB_URI`                   | Hosted MongoDB connection string (see [`atlas.md`](atlas.md)). Secret                                                                                                                          |
| `SESSION_SECRET`                | 32+ random characters. Secret                                                                                                                                                                  |
| `COOKIE_SAMESITE`               | `lax` (not a secret)                                                                                                                                                                           |
| `TRUST_PROXY`                   | `1`: one proxy in front of the API, so rate limits and cookies see the client                                                                                                                  |
| `ALLOW_PRIVATE_HOSTS`           | `false`. The API refuses to start with `true` in production                                                                                                                                    |
| `LLM_PROVIDER`                  | `groq` or `gemini`                                                                                                                                                                             |
| `GROQ_API_KEY` or `LLM_API_KEY` | The key of the selected provider. Secret                                                                                                                                                       |
| `LLM_MODEL`                     | For example `openai/gpt-oss-20b` (Groq)                                                                                                                                                        |
| Optional                        | `LLM_THINKING_LEVEL`, `LLM_REQUEST_TIMEOUT_MS`, `LLM_MAX_RETRIES`, `LLM_MAX_CONCURRENCY`, `LLM_MIN_INTERVAL_MS`, `LOG_LEVEL`, `SESSION_TTL_HOURS`, `AUTH_RATE_LIMIT_MAX`, `API_RATE_LIMIT_MAX` |

**Web service (build time)**

| Name                  | Value                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL` | `/api` (same origin). Public by design; baked into the bundle when the web app is built |

**Not needed on Vercel:** `PORT`, `MONGO_ROOT_USER`, `MONGO_ROOT_PASSWORD`, `MONGO_PORT`, `TEST_MONGODB_URI`.
Keep the web service's build-time variable scoped to the web service if the dashboard allows it, and never put
a secret in a `NEXT_PUBLIC_*` variable.

**Windows note:** Git Bash rewrites an argument that looks like a Unix path, so `NEXT_PUBLIC_API_URL=/api` or
`make build-production API_URL=/api` typed in Git Bash becomes a `C:/Program Files/Git/api` path and the build
fails with "must use https". Use PowerShell or cmd, or set the variable in the Vercel dashboard (Linux, where
this does not happen).

`NEXT_PUBLIC_API_URL=/api` passes `make build-production API_URL=/api`, which fails for an unset, localhost,
non-https absolute or malformed value. The deployed app also refuses to call anything if the value is bad.

### Jobs on Vercel: what is and is not guaranteed

Generation and regeneration jobs still run **inside the API invocation that accepted them**, with no queue.
That is the one architectural limit of this deployment.

- After answering `202`, the job asks Vercel to keep the invocation alive until it finishes, using the
  documented `waitUntil` from the official `@vercel/functions` package (version 3.10.1, Apache-2.0, Node 20 or
  newer). This is a request, not a guarantee, and outside Vercel it does nothing. The MongoDB client is also
  registered with the package's `attachDatabasePool` so idle connections are released before an instance is
  suspended.
- The job document in MongoDB is the durable record. If the invocation ends before the job records its outcome
  (timeout, platform recycling, crash), nothing resumes it.
- Therefore the startup sweep (`failInterrupted`, which assumes one process) is **not** used here: a cold start
  would fail jobs another instance is running. Instead, an active job whose document has not been updated for
  **6 minutes** (longer than the 300 s default invocation limit) is failed with `JOB_TIMED_OUT` the next time any
  job is submitted or that job is read. The user sees an honest failure and can resubmit. A stuck job also stops
  counting toward the per-user limit of 3 active jobs.
- One case is limited to 90 s by the pipeline, so a healthy job finishes well inside the invocation limit. A
  slow provider (many rate-limit retries) can still make it fail; nothing is resumed or retried automatically.
- A very reliable setup would need a queue or a worker (for example Vercel Queues, Workflow or Daemons, or a
  separate worker host). That is **not** built, and is listed under "Remaining limitations".

### What is known about the build, and what is not

Known from the code and Vercel's documentation (read 2026-10-20):

- The API entry (`apps/api/src/server.ts`) imports `express` and default-exports the app, which is what Vercel's
  Express support asks for. The API package is `"type": "module"`.
- Vercel's Express page says the application becomes **one function** and that its bundling "does not perform
  application bundling (e.g. Webpack or Rollup)", only removes unneeded files. Vercel's Node.js page describes
  TypeScript support for files in `/api` and a `tsconfig.json` (path mappings are not supported).
- **Unknown, and the biggest risk:** the three workspace packages (`@trao/contracts`, `@trao/core`,
  `@trao/pipeline`) are consumed as **TypeScript source** (`exports` point at `src/index.ts`), and many of their
  relative imports have **no file extension** (`packages/core`: 21 imports, `packages/contracts`: 9), which is
  valid for the bundler-style resolution used locally but not for plain Node ESM. Whether Vercel compiles
  TypeScript that lives in sibling workspace packages, and resolves such imports, is not stated in the
  documentation I read, and cannot be established without a real build. Nothing in this repository proves it.
- Also unconfirmed: that Vercel installs the pnpm workspace from the repository root for a service whose root is
  `apps/api/` (the lockfile is at the root), and that Express's body parser works when Vercel pre-parses request
  bodies for Node functions.

If the first deployment fails to build or load the API, the likely fixes are (each needs your approval first):

1. Bundle the API (and the workspace packages) into one JavaScript file before deploying, with a build step. The
   usual tool is `esbuild`; it is installed only as a dependency of `tsx` today, so using it directly means adding
   it as a declared dependency.
2. Or compile the workspace packages and add the missing `.js` extensions to their imports so plain Node ESM can
   load them (a mechanical edit of about 30 import lines, plus a build step for the packages).

Execution limits (Hobby): Vercel's limits page lists, with Fluid compute, a **300 s default and maximum duration**,
2 GB memory and 4.5 MB request and response bodies. Fluid compute is the default for new projects; for an older
project check the setting, because the limits without it are much lower. The measured live generation with Groq
took 45 s (one run, one posting), and a case is cut off by the pipeline at 90 s, so a generation request should
fit **if** the project really has the 300 s limit. That cannot be confirmed without deploying, and a slow
provider with many rate-limit retries is not covered by one measurement. Hobby is intended for personal,
non-commercial use; read the current terms before using it.

### Remaining limitations and unverified items

- **Not deployed or tested on Vercel.** The `vercel.json` syntax, the prefix transform, the TypeScript build of
  the Express service (the workspace packages export TypeScript source, so bundling them is the biggest
  unknown), and `waitUntil` behaviour are unconfirmed until a deployment.
- **Preview deployments will not sign in or write.** `WEB_ORIGIN` is one fixed origin, so every preview URL fails
  the CSRF check. Use production (or a fixed custom domain) for testing, or ask for a list-of-origins change.
- **Rate limits are in memory per instance**, so they do not add up across instances.
- **Cold starts** run the index check once per instance (idempotent, one round trip per index).
- Plan limits apply (for example a 300 s maximum invocation on the Hobby plan, 4.5 MB request and response
  bodies). Costs and quotas were not checked for your account.
- Deployment Protection (Vercel authentication) on a project hides it from the public; turn it off only for the
  production domain if the app must be public.

### Steps (when you decide to deploy)

1. Create a hosted MongoDB first (see [`atlas.md`](atlas.md)) and keep its connection string secret.
2. Import the GitHub repository in Vercel, framework preset **Services**. Vercel reads `vercel.json`.
3. Add the environment variables above (API service and `NEXT_PUBLIC_API_URL=/api` for web).
4. Deploy production only (no preview support in this phase). Choose the domain, set `WEB_ORIGIN` to it and
   redeploy so the API picks it up. Use a **new** random `SESSION_SECRET`: the local `.env` still has the
   placeholder value from `.env.example`, which must never be used in production.
5. Check `https://<domain>/api/health` (answers without the database) and `https://<domain>/api/ready`
   (database reachable), then register, create a kit and reload to confirm the cookie persists.

---

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
