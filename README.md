# AI Interview Prep Kit

Turns a pasted job description and a company website into a personalised interview preparation kit:
company brief, role breakdown, categorised question bank, flashcards and a day-by-day schedule, with
an editable builder and a practice mode. Built for the Trao full-stack assessment.

> **Status: Phase 1 (foundation).** Tooling, shared contracts and CI scaffold exist. The research
> pipeline, API, UI and batch evaluation are not implemented yet. See
> [`docs/requirements-traceability.md`](docs/requirements-traceability.md) for the honest status of
> every requirement. This README is completed in Phase 10.

## Layout

```text
apps/web            Next.js + Tailwind frontend
apps/api            Express backend
packages/contracts  Zod schemas for the kit (Appendix A) and batch files (Appendix B)
packages/core       Deterministic logic: coverage, schedule, validation (no I/O)
packages/pipeline   Research + LLM stages + orchestration, shared by API and CLI
scripts/evaluate.ts Batch CLI entry point
docs/               Traceability and decision log
```

## Prerequisites

- Node.js >= 20.19 (developed on 24, CI on 22)
- pnpm 10 (`npm i -g pnpm@10`)
- Docker (local MongoDB) and GNU Make (optional; every target wraps a pnpm script)

## Commands

```bash
pnpm install
pnpm lint | pnpm format:check | pnpm typecheck | pnpm test | pnpm build
npm run evaluate -- --input cases.json --output kits.json   # pipeline wired in Phase 6
```

Copy `.env.example` to `.env`; every variable is documented there. Never commit `.env`.
