# AI Interview Prep Kit

Turns a pasted job description and a company website into a personalised interview preparation kit:
company brief, role breakdown, categorised question bank, flashcards and a day-by-day schedule, with
an editable builder and a practice mode. Built for the Trao full-stack assessment.

> **Status: Phase 5 of 10 (AI pipeline).** Implemented and tested: shared contracts, the deterministic
> core (coverage, schedule, kit validation), the Express/MongoDB backend, the research engine, and the
> generation stages (provider-neutral LLM layer with a Gemini adapter, requirement extraction, company
> brief, per-category questions, flashcards, a deterministic bounded coverage loop, final kit
> validation). **Not implemented yet:** wiring research and generation into the API job runner and the
> batch evaluator (`npm run evaluate` still exits 2), the web UI, practice mode, deployment. Jobs still
> fail honestly with `PIPELINE_NOT_IMPLEMENTED`. **The five-case 15-minute batch requirement is not met on
> the free tier of this model:** the free daily request quota observed for `gemini-3.8-flash` (20 a day)
> allows about two cases at roughly seven requests each. See "LLM provider" below. See [`docs/requirements-traceability.md`](docs/requirements-traceability.md) for the status of
> every requirement. This README is completed in Phase 10.

## Layout

```text
apps/web            Next.js + Tailwind frontend (shell only so far)
apps/api            Express + MongoDB backend
packages/contracts  Zod schemas: Appendix A kit, Appendix B batch files, API request bodies
packages/core       Deterministic logic: coverage, schedule, kit validation (no I/O)
packages/pipeline   Research + LLM stages + orchestration, shared by API and CLI (Phases 4-6)
scripts/evaluate.ts Batch CLI entry point (Phase 6)
docs/               api.md, architecture.md, requirements-traceability.md, development-decisions.md
```

## Prerequisites

- Node.js >= 20.19 (developed on 24, CI on 22)
- pnpm 10 (`npm i -g pnpm@10`)
- Docker, for local MongoDB (GNU Make is optional; every target wraps a pnpm script)

## Local setup

```bash
pnpm install
cp .env.example .env            # then edit; .env is git-ignored
docker compose up -d mongo      # MongoDB 8 on 127.0.0.1:${MONGO_PORT:-27017}
pnpm dev                        # API on :4000 and web on :3000
```

If port 27017 is already used by another MongoDB on your machine, set `MONGO_PORT=27018` in `.env`
and use 27018 in `MONGODB_URI` and `TEST_MONGODB_URI`.

Every environment variable is documented in [`.env.example`](.env.example). Secrets (`SESSION_SECRET`,
database credentials, the LLM key) are server-side only and must never be committed; the example file
contains placeholders. In production the API refuses to start with a weak `SESSION_SECRET` or with
`ALLOW_PRIVATE_HOSTS=true`.

## Commands

| Command                                                     | What it does                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm test`                                                 | Unit tests (no database needed)                                     |
| `pnpm test:integration`                                     | API integration tests against a **real MongoDB** (fails if absent)  |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check`        | Static checks                                                       |
| `pnpm build`                                                | Next.js production build; the API is type-checked (not bundled yet) |
| `npm run evaluate -- --input cases.json --output kits.json` | Required batch entry point. Pipeline is wired in Phase 6            |

`make test-integration`, `make up`, `make down` etc. are thin wrappers. Integration tests create and
drop a throwaway database per test file; they use `TEST_MONGODB_URI` (default: the Compose service
on port 27018 with the credentials from `.env.example`). CI runs them against a `mongo:8` service
container.

## API

Routes, status codes, the error model, session and CSRF design, optimistic concurrency, the job
lifecycle and the index table are documented in [`docs/api.md`](docs/api.md). In short:

- `POST /auth/register | /auth/login | /auth/logout`, `GET /auth/me`
- `GET/POST /kits`, `GET/PUT/DELETE /kits/:id` (PUT takes the `version` you last read; stale writes
  get `409 VERSION_CONFLICT`)
- `POST /generation-jobs` (`202`, deduplicated while a job for the same input is active),
  `GET /generation-jobs/:id`
- `GET /health` (liveness), `GET /ready` (database)

## Security model (implemented so far)

argon2id password hashing; opaque 256-bit session ids stored server-side only as an HMAC; `HttpOnly`,
`SameSite`, and in production `Secure` + `__Host-` cookies; strict Origin check and CORS allow-list;
owner-scoped queries with a uniform `404` for foreign resources; per-IP rate limiting; Helmet headers;
request-body size limit; one structured error shape with generic 500s and request ids; log redaction.
Limitations are listed in `docs/api.md` (notably: rate limiting is in-memory per process, and
generation jobs run in-process and cannot resume after a restart).

## Research engine

`packages/pipeline` fetches untrusted web pages, so every request goes through one safe fetcher:
http(s) only, public addresses only (validated and pinned, so DNS cannot be rebound), every redirect
re-validated, hard limits on size, decompression, content type and time. The crawler reads
robots.txt first, keeps to the company site, follows links it discovers (no fixed list of paths),
ranks them deterministically and judges pages by their content to find hiring and interview-process
pages. Public discussion comes from the Hacker News Algolia API only. Every limit and every
limitation, including what the manual live check found, is in
[`docs/architecture.md`](docs/architecture.md). Loopback fixture sites are allowed only for an
explicit `host:port` (development, tests, batch) and never in production.

## LLM provider

**Google Gemini through Google AI Studio, model `gemini-3.8-flash`** (listed as Stable with a free tier in
Google's documentation, checked 2026-10-19; see `docs/development-decisions.md` for the sources). The code
is provider-neutral; `LLM_MODEL` selects the model and it is **never substituted automatically**.

**Get a key:** open https://aistudio.google.com/apikey, create a key, and put it in `.env`:

```bash
cp .env.example .env      # if you have not already
# then edit .env:  LLM_API_KEY=<your key>
```

The key is server-side only: it is read from the environment, sent in a request header, and never logged,
returned in errors, or written to disk by the application. `.env` is git-ignored. If the key is missing the
application fails with a clear configuration error and makes no request. **Quotas are not hard-coded**:
Google does not publish per-model limits, so check yours in AI Studio.

> **Free-tier quota: read this before running the batch.** When this was measured (2026-10-19) the free
> tier of `gemini-3.8-flash` on the development project answered
> `limit: 20 requests per day on Free Tier`. One case needs about 7 requests, so **about two cases per day;
> five do not fit**. The pipeline stops immediately on such an error (it does not retry a day-long wait),
> returns what it has marked `incomplete`, and says when the quota resets. Options: enable billing (roughly
> $0.025 per case by token arithmetic), choose a model with a larger free allowance, or spread cases over days.
> Details and the evidence are in `docs/architecture.md`.

All tuning variables
(`LLM_REQUEST_TIMEOUT_MS`, `LLM_MAX_RETRIES`, `LLM_MAX_CONCURRENCY`, `LLM_MIN_INTERVAL_MS`,
`LLM_THINKING_LEVEL`) are documented in `.env.example`.

> **Privacy.** On the free tier Google may use prompts and responses to improve its products, and human
> reviewers may read them. Do not paste confidential or personal information into job descriptions.

**Measure your own setup** (sends a sample posting to Google; not part of `pnpm test`):

```bash
pnpm llm:smoke                              # sample posting and sample research
pnpm llm:smoke --url https://example.com/   # crawl a real site first, then generate
```

It prints the model calls, retries, tokens and per-stage durations, and writes the result to the
git-ignored `out/` folder. The unit tests use a fake provider and never need a key.

## Deterministic core

Coverage checking, schedule allocation and kit validation are pure functions in `packages/core`,
described in [`docs/architecture.md`](docs/architecture.md).
