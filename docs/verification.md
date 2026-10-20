# Verification: what was checked, how, and what was not

This page separates four kinds of evidence, because they are not worth the same:

- **Automated** - a test in the repository that passes (`pnpm test`, `pnpm test:integration`).
- **Mocked** - automated, but against a fake (a fake model, local fixture websites, a fake API in jsdom).
- **Reviewed** - someone read the code or ran something by hand; no test protects it.
- **Real environment** - a real browser, a real provider, a real deployment. **None of these has been done.**

The requirement-by-requirement status is in [`requirements-traceability.md`](requirements-traceability.md).

## Commands

| Command                                              | What it proves                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm test`                                          | Unit and component tests (no database). Uses fakes only: no network beyond localhost fixtures. |
| `pnpm test:integration`                              | API tests against a **real MongoDB** (fails, never skips, if none is reachable).               |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check` | Static checks over every package, the CLI script and the tests.                                |
| `pnpm build`                                         | The Next.js production build. The API is type-checked, not bundled.                            |

Neither command uses the Vitest JSON reporter. There is **no coverage tooling**: `@vitest/coverage-v8` is
not installed and no threshold is configured, so no coverage figure exists and none is claimed.

## What is not covered, and the smallest way to cover it

**Browser and end-to-end tests (not done).** `pnpm test:e2e` deliberately fails with a message; there are
no browser tests, no automated accessibility scan, and the browser-to-API cookie and CORS flow has never
run in a real browser (the CORS and cookie attributes are asserted at the HTTP level in
`platform.integration.test.ts` and `auth.integration.test.ts`; SameSite and CORS enforcement by a browser is
not). The smallest additions that would cover it are three dev dependencies, **not installed**:

| Dependency             | Purpose                                                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@playwright/test`     | Drive a real Chromium against a locally started web app and API: sign-in, create, edit, conflict, regenerate, practice, phone-width, keyboard. Needs a one-time browser download (`playwright install chromium`). |
| `@axe-core/playwright` | Automated accessibility scan of those pages (labels, roles, contrast where computable).                                                                                                                           |
| `@vitest/coverage-v8`  | Coverage figures for the unit suites, if a threshold is wanted.                                                                                                                                                   |

Playwright would use the fake model seam and fixture sites that already exist, a throwaway database and
random ports, so it needs no key and touches no existing data.

## Clean setup (isolated snapshot)

The repository has no commits for most of the work, so an exact `git clone` test is impossible; this uses
an isolated copy of the working tree instead and does not touch the real one:

```bash
# from the repository root: copy tracked + untracked files, excluding everything git ignores
# (.env, out/, node_modules/, .next/), into a temporary directory
git ls-files -co --exclude-standard -z | xargs -0 cp --parents -t "$TMP/copy"
cd "$TMP/copy"
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm test:integration && pnpm build
npm run evaluate -- --input cases.json --output kits.json   # exit 4 and a clear message without LLM_API_KEY
```

Results are recorded in the Phase 9 report, with what could not be done in this environment.

## Five cases in fifteen minutes (simulated, not measured)

`packages/pipeline/src/five-case-budget.test.ts` runs five cases through `runBatch` with a fake model that
costs a stated amount of fake time per call and, optionally, rate limits with a stated `Retry-After`. Calls
add up one after another (the slowest schedule, since the pipeline overlaps some). At 6 s per call the five
cases take 210 s; with a quarter of calls rate limited for 20 s each they still fit; with a model so slow
that cases cannot finish, the batch stops at its 14-minute budget and records the remaining cases as
failed rather than hanging. This shows the **batch logic** is sound. **It is not a measurement of any real
model**, whose latency and quota decide the real time (see the README on the observed free-tier limit).

**To measure a real provider (not run; needs your key and consumes quota):**

1. Put your key in `.env` (`LLM_API_KEY`), never in the command line.
2. Prepare five cases of your own in `cases.json` (Appendix B input) with public company sites.
3. `time npm run evaluate -- --input cases.json --output kits.json`; the command prints each case's status,
   limitations and timing to stderr.
4. Record: total wall time, per-case time, number of model calls and any `LLM_RATE_LIMITED` or
   `LLM_QUOTA_EXHAUSTED` codes. With the free-tier quota recorded in the README (about 20 requests a day for
   `gemini-3.8-flash` when measured) five cases do not fit; that is a provider limit, not a pipeline one.
