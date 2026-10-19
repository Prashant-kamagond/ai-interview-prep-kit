# AI Interview Prep Kit

Turns a pasted job description and a company website into a personalised interview preparation kit:
company brief, role breakdown, categorised question bank, flashcards and a day-by-day schedule, with
an editable builder and a practice mode. Built for the Trao full-stack assessment.

> **Status: Phase 3 of 10 (backend and persistence).** Implemented and tested: shared contracts, the
> deterministic core (coverage, schedule, kit validation), and the Express/MongoDB backend
> (authentication, kit CRUD with ownership and optimistic concurrency, generation-job lifecycle with
> deduplication). **Not implemented yet:** company research, the LLM pipeline, the batch evaluator
> (`npm run evaluate` exists but exits 2), the web UI, deployment. Generation jobs therefore fail
> honestly with `PIPELINE_NOT_IMPLEMENTED`. See
> [`docs/requirements-traceability.md`](docs/requirements-traceability.md) for the status of every
> requirement. This README is completed in Phase 10.

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

## Deterministic core

Coverage checking, schedule allocation and kit validation are pure functions in `packages/core`,
described in [`docs/architecture.md`](docs/architecture.md).
