# API reference (Phase 3)

Everything below is implemented and covered by tests unless it is listed under **Limitations**.
Source: `apps/api/src`. Request/response schemas shared with the frontend: `packages/contracts`.

## Routes

"Auth" means a valid session cookie is required (otherwise `401`). "Origin" means the request must
carry an `Origin` header equal to `WEB_ORIGIN` (otherwise `403 CSRF_ORIGIN_REJECTED`); this applies to
every `POST`/`PUT`/`DELETE`.

| Method | Path                   | Auth | Origin | Success                         | Notes                                                                                |
| ------ | ---------------------- | ---- | ------ | ------------------------------- | ------------------------------------------------------------------------------------ |
| GET    | `/health`              | no   | no     | `200 {status:"ok"}`             | Liveness. Never touches the database.                                                |
| GET    | `/ready`               | no   | no     | `200 {status:"ready"}`          | Readiness. `503 {status:"unavailable"}` if MongoDB does not answer, with no detail.  |
| POST   | `/auth/register`       | no   | yes    | `201 {user}` + cookie           | Rate limited. `409 EMAIL_TAKEN`.                                                     |
| POST   | `/auth/login`          | no   | yes    | `200 {user}` + cookie           | Rate limited. `401 INVALID_CREDENTIALS` (same for unknown email and wrong password). |
| POST   | `/auth/logout`         | no   | yes    | `204`                           | Idempotent. Deletes the session server-side and clears the cookie.                   |
| GET    | `/auth/me`             | yes  | no     | `200 {user}`                    |                                                                                      |
| GET    | `/kits`                | yes  | no     | `200 {kits:[summary]}`          | Own kits only, most recently edited first.                                           |
| POST   | `/kits`                | yes  | yes    | `201 {id,version,kit,warnings}` | Body `{kit}`. `422 KIT_INVALID` if validation errors.                                |
| GET    | `/kits/:id`            | yes  | no     | `200 {id,version,kit,…}`        | `404` if missing **or not yours**.                                                   |
| PUT    | `/kits/:id`            | yes  | yes    | `200 {id,version,kit,warnings}` | Body `{version, kit}`. `409 VERSION_CONFLICT` if stale.                              |
| DELETE | `/kits/:id`            | yes  | yes    | `204`                           | `404` if missing or not yours.                                                       |
| POST   | `/generation-jobs`     | yes  | yes    | `202 {job, deduplicated}`       | `Location` header. Body `{jd, company_url, days}`.                                   |
| GET    | `/generation-jobs/:id` | yes  | no     | `200 {job}`                     | `404` if missing or not yours.                                                       |

Rate limits (per IP, in memory): register/login `AUTH_RATE_LIMIT_MAX` per 15 minutes; everything else
`API_RATE_LIMIT_MAX` per minute. Exceeding either gives `429 RATE_LIMITED`.

## Errors

Every error has one shape, and only curated text reaches the client:

```json
{ "error": { "code": "VERSION_CONFLICT", "message": "…", "details": {}, "request_id": "…" } }
```

| Status | Codes                                                                                   |
| ------ | --------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR` (`details`: `[{path,message}]`), `INVALID_JSON`                      |
| 401    | `UNAUTHENTICATED`, `SESSION_EXPIRED`, `INVALID_CREDENTIALS`                             |
| 403    | `CSRF_ORIGIN_REJECTED`                                                                  |
| 404    | `NOT_FOUND` (also used for other users' resources)                                      |
| 409    | `EMAIL_TAKEN`, `VERSION_CONFLICT` (`details.current_version`)                           |
| 413    | `PAYLOAD_TOO_LARGE` (body limit 1 MB)                                                   |
| 415    | `UNSUPPORTED_MEDIA_TYPE`                                                                |
| 422    | `KIT_INVALID` (`details`: validation issues with `code`, `path`, `message`)             |
| 429    | `RATE_LIMITED`                                                                          |
| 500    | `INTERNAL_ERROR` — always the generic message "Something went wrong. Please try again." |

Unexpected errors (database failures, bugs) are logged server-side with the request id and answered
with the generic 500. Driver messages, hostnames, connection strings and stack traces never leave
the process (tested by injecting a driver error that contains a fake connection string).

## Authentication and sessions

- **Passwords:** argon2id (`@node-rs/argon2`, m=19456 KiB, t=2, p=1 — the OWASP minimum), 10–128
  characters. Login for an unknown email burns the same CPU as a real check, and returns the same
  response as a wrong password.
- **Session id:** 256 random bits (`crypto.randomBytes(32)`), base64url, carried in an `HttpOnly`
  cookie. **MongoDB stores only `HMAC-SHA256(SESSION_SECRET, token)`**, so a copy of the sessions
  collection does not yield usable cookies. Rotating `SESSION_SECRET` signs everyone out.
- **Cookie:** `HttpOnly`; `SameSite=Lax` by default (`COOKIE_SAMESITE` to change); `Secure` and the
  `__Host-` name prefix (no `Domain`, `Path=/`) in production.
- **Lifetime:** absolute, `SESSION_TTL_HOURS` (default 7 days). A TTL index deletes expired records
  (its monitor runs about once a minute), and the code checks `expiresAt` itself, so an expired
  session is never honoured. A known-but-expired session answers `SESSION_EXPIRED` once and is
  removed; an unknown or malformed cookie answers `UNAUTHENTICATED`. Both clear the cookie.
- **Logout** deletes the server-side record, so a copied cookie stops working immediately.

### CSRF

Defence in depth: `SameSite` cookies, JSON-only bodies, and a **strict `Origin` check** on every
state-changing request (see `middleware/origin-check.ts`). A request from another site, or with no
`Origin`, is rejected before it reaches a handler. CORS is a strict allow-list of `WEB_ORIGIN`
(credentials allowed; the CORS headers are not emitted for any other origin).

Limitations: the check relies on the browser sending `Origin` on unsafe requests (all current
browsers do). Non-browser clients cannot use the cookie endpoints. If the frontend and API are
deployed on different sites, `SameSite=Lax` cookies are not sent on cross-site `fetch`; the options
are a same-site reverse proxy (for example Next.js rewrites) or `COOKIE_SAMESITE=none`, which makes
the Origin check the primary CSRF defence. That decision is made at deployment (Phase 10).

## Ownership

Every kit and job query includes the owner's id **in the database filter** (`{_id, userId}`); there
is no code path that loads a document and checks ownership afterwards. A foreign id, a missing id
and a malformed id all produce the identical `404 NOT_FOUND`, so the API does not reveal which ids
exist. For the same reason an update to a foreign kit answers `404`, not `409`, even with a wrong
version. Responses never include `userId`, password hashes or session records.

## Kits and optimistic concurrency

A kit document is `{ _id, userId, kit (Appendix A, embedded), version, createdAt, updatedAt }`.

- Bodies are validated with the shared Phase 2 `validateKit`. **Errors** (bad structure, dangling
  references, schedule invariants, coverage that disagrees with the questions) give
  `422 KIT_INVALID`. **Warnings** (for example an unscheduled question in an edited draft) never
  block a save and are returned in `warnings`. A coverage gap that is honestly reported in
  `coverage.uncovered_requirement_ids` is valid; reporting it wrongly is an error.
- `PUT` requires the `version` the client last read. The write is one atomic
  `findOneAndUpdate({_id, userId, version})` that also increments `version`, so of N simultaneous
  writers from the same version exactly one succeeds and the rest get `409 VERSION_CONFLICT` with
  `details.current_version`. A stale update never overwrites newer data (tested, including 8
  concurrent writers).
- The version starts at 1 and increases by exactly 1 per successful update.

## Generation jobs

```text
queued ──► running ──► succeeded
   │          │
   └──────────┴──────► failed          (succeeded and failed are terminal)
```

- `POST /generation-jobs` validates `{jd, company_url, days}` (days 1–60, http(s) URL; a two-line
  description is valid input), inserts a `queued` job, returns `202` with the job and a `Location`
  header, and starts the work after the response.
- Transitions are enforced in the database: `findOneAndUpdate({_id, status: {$in: legalSources}})`.
  A job can only reach `succeeded` through `running`, and nothing leaves a terminal state.
- **Success requires a kit the owner has.** If a runner returns a kit id the user does not own, the
  job is failed rather than marked successful.
- **Honest failures:** until the real pipeline exists the default runner fails every job with
  `PIPELINE_NOT_IMPLEMENTED`. A runner's `JobFailure` keeps its code and message; any other error is
  logged and stored as a generic `INTERNAL_ERROR`.
- **Deduplication:** `inputHash = sha256(v1, normalised jd, normalised company_url, days)` after
  collapsing whitespace and line endings and normalising URL host case, trailing slash and
  fragment. No credentials or user data are hashed. A partial **unique index on
  `(userId, inputHash)` where `active: true`** makes the database the arbiter: of N simultaneous
  identical requests exactly one insert wins, the others read the winner back and return it with
  `deduplicated: true`. Once a job is terminal (`active: false`) the same request creates a new job.
- The status response exposes `id, status, stage, progress, kit_id, error, timestamps` — never the
  request payload, its hash or the owner.

**In-process limitation.** Jobs run inside the API process with no queue. The job document is a
durable record, but MongoDB cannot resume an interrupted task. At startup `failInterrupted()` marks
any job still `active` as `failed` (`SERVER_RESTARTED`) so users see an honest terminal state and can
resubmit. That sweep assumes a single API instance; with several it would fail jobs running on the
others.

## Indexes

| Collection        | Index (name)                                                                            | Purpose                                                        |
| ----------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `users`           | `{email:1}` unique (`email_unique`)                                                     | Atomic duplicate-registration protection; login lookup.        |
| `sessions`        | `_id` = hashed token; `{expiresAt:1}` TTL 0 (`expiresAt_ttl`); `{userId:1}`             | Cookie lookup; automatic expiry; per-user cleanup.             |
| `kits`            | `{userId:1, updatedAt:-1}` (`userId_updatedAt`)                                         | "My kits, newest edit first". Every kit query is owner-scoped. |
| `generation_jobs` | `{userId:1, inputHash:1}` unique, partial `active:true` (`active_job_per_input_unique`) | One active job per user and input, enforced by the database.   |
|                   | `{userId:1, createdAt:-1}` (`userId_createdAt`)                                         | A user's jobs by recency.                                      |
|                   | `{createdAt:1}` partial `active:true` (`active_jobs`)                                   | Startup sweep of orphaned jobs.                                |

`ensureIndexes()` is idempotent and runs at startup and in every test database.

## Limitations (known, deliberate)

- Rate limiting is in-memory and per process: it resets on restart and is multiplied across
  instances.
- Registration reveals whether an email is taken (`409`). Account enumeration is accepted in
  exchange for a clear error; email verification and password reset are out of scope.
- Sessions have an absolute lifetime only: no sliding expiry, no "sign out everywhere", no session
  list. There is no account deletion.
- `PUT /kits/:id` replaces the whole kit. Version checking is per kit, so two edits to different
  parts still conflict. Granular, merge-based builder updates (generated/edited/pinned/deleted
  state) are Phase 7. Fields outside Appendix A are dropped by validation.
- Deleting a kit does not touch jobs that reference it.
- Duplicate protection covers only in-progress jobs. How a previously _completed_ identical request
  is treated (reuse vs regenerate) is decided with the real pipeline in Phase 6.
- `ALLOW_PRIVATE_HOSTS` is validated at startup (production refuses `true`) but nothing consumes it
  until the research layer exists (Phase 4).
- `pnpm build` type-checks the API but does not bundle it; the API runs through `tsx`. A production
  bundle step is decided with deployment (Phase 10).
- Tested against a local MongoDB 8 container only. MongoDB Atlas has not been exercised.
