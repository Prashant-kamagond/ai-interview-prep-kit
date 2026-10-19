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

## Phase 3

- **Session ids are stored as an HMAC, not raw.** The cookie holds 256 random bits; MongoDB holds
  `HMAC-SHA256(SESSION_SECRET, token)`. A leaked database dump cannot be replayed as cookies. Cost:
  rotating `SESSION_SECRET` signs everyone out (acceptable and documented).
- **argon2id via `@node-rs/argon2`** (prebuilt binaries, no install script) rather than the
  node-gyp-based `argon2` package, which needs build scripts that pnpm blocks by default.
- **CSRF by strict Origin check**, plus SameSite and JSON-only bodies. Chosen over double-submit
  tokens because the API serves one known web origin and a token would add client state. The cost is
  that cookie endpoints are browser-only, which is acceptable here.
- **Ownership lives in the query filter**, never "load, then compare". Foreign, missing and malformed
  ids all return the same 404, and a stale update to a foreign kit returns 404 (not 409) so a
  conflict cannot reveal that the kit exists.
- **Optimistic concurrency is a version field in the update filter**, giving an atomic
  check-and-write with no transactions. Whole-kit granularity for now; the Phase 7 builder will add
  merge-based updates on top of the same primitive.
- **Warnings do not block saving a draft**; errors do. A reported coverage gap is valid.
- **Deduplication by partial unique index** on `(userId, inputHash)` where `active: true`, using an
  explicit boolean because equality is the most widely supported partial-index filter, so the design
  does not depend on whether a given server version accepts `$in`. Check-then-insert would race; the
  index cannot.
- **Jobs run in-process with an honest default runner** (`PIPELINE_NOT_IMPLEMENTED`). I chose a
  failing runner over a fake success so no code path can claim a kit that was never generated. The
  startup sweep fails orphaned jobs; it does not pretend to resume them.
- **Integration tests fail, not skip, without MongoDB**, and live behind `pnpm test:integration` so
  `pnpm test` stays fast and database-free. Each file uses a throwaway database dropped afterwards
  (verified: 0 leftover test databases).
- **Fault injection by wrapping `Db`**, not by closing the client. I believe current MongoDB drivers
  reconnect implicitly after `close()` (so closing would not simulate an outage), but I did not
  verify that; the wrapper is deterministic regardless, and the passing test shows it works.
- **Port 27017 was already taken** on the development machine by a pre-existing local `mongod`
  service. It was left untouched; Compose now publishes on `${MONGO_PORT:-27017}` and the local
  `.env` uses 27018.
- **Mutation checks again:** removing the owner filter, the version filter, and the Origin check each
  made tests fail (2, 2 and 3 failures respectively); the code was then restored.
- **Two bugs found by the first integration run, both in my tests** (a mixed-case email query and a
  session count over a shared database), and **one in the code** (CORS emitted its header for every
  origin; now a strict allow-list). All fixed without weakening any assertion.

## Phase 4

- **DNS pinning through a custom `lookup`.** Node's HTTP client accepts a `lookup` function; mine resolves
  once, validates every answer, and returns that address to the socket, so there is no second
  resolution to rebind. Alternatives considered: connecting to the IP and setting `Host` by hand
  (breaks TLS SNI and certificate checks) and a proxy (extra infrastructure). Because Node skips
  `lookup` for IP literals, literals are validated before the request.
- **One bad address rejects the whole DNS answer**, rather than filtering to the good ones, so there is
  never an ambiguity about which address was meant.
- **Loopback fixtures are a `host:port` allow-list, not a boolean.** A global "allow private hosts"
  switch would let any public site redirect the crawler at local services. The list is derived from
  the case's own company URL and only when that URL is on loopback; production refuses it twice
  (policy constructor and API config).
- **Port allow-list (80, 443, 8080, 8443)** on public hosts, to stop the crawler probing internal
  services on unusual ports. Cost: a company site on another port is rejected.
- **robots.txt follows RFC 9309:** 4xx means no restrictions, unreachable means nothing is crawled.
  The second is conservative and means a flaky robots.txt can cost a whole site; the limitation is
  recorded instead of hidden. Retries are bounded so it cannot hang a run.
- **Hiring pages are judged by content, links are only ranked.** Anchor wording is too varied to be
  decisive, so ranking decides what to fetch first and a separate content classifier decides what
  counts as a hiring page. Both are deterministic, table-driven and explainable (they return their
  evidence), and neither calls a model.
- **Truncate instead of fail for oversize pages.** The first live check showed `posthog.com`'s HTML
  exceeds 1 MB, so rejecting made the whole site `unreachable`. Pages are now read up to 3 MB and
  marked `truncated`; decompression stays bounded. Rejection remains the default for everything else
  (robots.txt, API responses). This changed one Phase 4 test on purpose (an oversize page is now a
  truncated page, not a failure) and added several for the new mode.
- **Hacker News only, behind an interface.** Reddit's unauthenticated JSON and DuckDuckGo HTML are not
  scraped. A relevance filter runs locally because the API returns anything matching the words.
  The filter was tightened after the live check: bare "interview" needs hiring words within 15 words,
  "Who is hiring?" threads are excluded, and the company must appear near the interview talk. It is
  still a heuristic, and the architecture notes give measured (small-sample) precision.
- **Deadlines are shared, not per request.** One research deadline is split 80/20 between crawl and
  discussion; retries and backoff stop when the next wait would pass it.
- **Mutation checks (all caught):** robots ignored, scope ignored, page budget ignored, unreachable
  robots treated as allow-all, loopback allow-list widened, production guard removed, `nofollow`
  ignored, resolved-address check removed, redirect target not validated, decompression not bounded,
  truncation not cut. One survivor (the provider kept querying after a 429) exposed a weak assertion
  and was fixed.
- **A shell-quoting trap, found and understood:** the tool's shell collapses doubled backslashes, so
  escapes typed in shell commands became real control characters (this also broke `evaluate.ts` in
  Phase 1). File edits now go through the file tools, or build strings from character codes.
- **Live checks changed the code twice** (size limit, discussion precision): fixtures alone would have
  shipped both defects.
