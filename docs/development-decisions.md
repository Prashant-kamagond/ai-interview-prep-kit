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
