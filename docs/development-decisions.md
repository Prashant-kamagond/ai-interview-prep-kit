# Development decisions

A running log of decisions that are not dictated by the assignment. The README summarises the
important ones.

## Phase 1

- **Monorepo with two extra packages.** `packages/core` (pure deterministic logic) and
  `packages/pipeline` (research + LLM stages + orchestration) are shared by the API and the batch
  CLI so there is exactly one pipeline implementation (PDF §9).
- **Workspace packages export TypeScript source** (`exports: ./src/index.ts`). No build step for
  libraries; `tsx`, Vitest and Next (`transpilePackages`) consume the source directly. Trade-off:
  the API's production build needs a bundler step, added in Phase 3 or 9.
- **TypeScript pinned to ~6.0.3, not the latest 7.0.2.** `typescript-eslint` 8.x declares support for
  `typescript >=4.8.4 <6.1.0`, so TS 7 would break linting. Revisit when it widens.
- **ESLint 10 flat config via `defineConfig`**; `tseslint.config` is deprecated.
- **pnpm installed per-user** (`npm i -g pnpm@10`) because Corepack needs admin rights on this
  machine. `packageManager` is pinned in `package.json`; CI uses `pnpm/action-setup`, which reads it.
- **`npm run evaluate` is a root script** that runs `tsx scripts/evaluate.ts`, so it works with plain
  npm while pnpm manages the workspace.
- **esbuild postinstall script is not approved.** Its binary ships as a prebuilt platform package, and
  `tsx` and Vitest run fine without the script. Verified by running both.
- **Compose contains only MongoDB for now**, bound to loopback with required credentials. App
  containers come once there are production builds (Phase 9).
- **LLM provider and hosting are deliberately undecided** until Phases 5 and 10, when current
  free-tier limits are checked against official documentation. Nothing is deployed or paid for
  without explicit approval.

## Phase 2

- **Validation is two layers.** Zod (`contracts`) owns structure; `validateKit` (`core`) owns
  cross-references and schedule invariants and reports precise paths. A structural failure
  short-circuits the reference checks.
- **Errors vs warnings.** `UNSCHEDULED_QUESTION` is a warning so a hand-added builder question does
  not invalidate a kit; anything that would break a reference is an error.
- **A must-have with no question is not a schedule error.** It is a coverage gap, and
  `coverage.uncovered_requirement_ids` must report it honestly (enforced by `COVERAGE_MISMATCH`).
- **Scheduling is rank-then-chunk, not bin-packing by minutes.** Chunks balance question counts and
  front-load the hardest material. It is simple to explain and test. The trade-off is that day
  lengths in minutes are uneven by design (harder days are longer).
- **Empty days are 30-minute review days** rather than being dropped or padded with invented
  questions, so the day count always equals the request and no id is ever fabricated.
- **`passes` counts coverage checks run**; proposed budget of 3, to be finalised in Phase 5.
- **Mutation-checked tests.** After the suites passed, I deliberately broke the must-first ranking and
  the coverage-mismatch rule to confirm a test fails for each, then restored the code.
