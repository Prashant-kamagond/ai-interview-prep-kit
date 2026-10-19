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

## Phase 5

### Provider verification (2026-10-19)

Google Gemini via Google AI Studio, behind a provider-neutral adapter, as instructed. Candidate model
`gemini-3.8-flash`. Everything below was read from the official documentation on **2026-10-19**, except
where it says it was observed live.

| Question                      | Finding                                                                                                                                                                                                                                                                                                                                                              | Source                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Model exists and is stable?   | `gemini-3.8-flash` is listed as **Stable** (marked new); the models page was last updated 2026-10-13. Preview models get at least 2 weeks' notice; the page gives no shutdown date for 3.8.                                                                                                                                                                          | https://ai.google.dev/gemini-api/docs/models                                                 |
| Model limits and capabilities | Input limit **1,048,576** tokens, output limit **65,536**; structured outputs supported; thinking levels low/medium/high (**"minimal" is rejected**, confirmed live); page updated 2026-09-02.                                                                                                                                                                       | https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash                                |
| Free tier?                    | The **Standard** tier lists a Free Tier "free of charge" for input and output tokens. Batch and Flex are not available on the free tier.                                                                                                                                                                                                                             | https://ai.google.dev/gemini-api/docs/pricing                                                |
| Quotas?                       | **Not published per model.** Limits are RPM, input TPM and RPD, per project, resetting at midnight Pacific; "can be viewed in Google AI Studio"; "not guaranteed". So **no quota number is hard-coded anywhere**; check yours in AI Studio.                                                                                                                          | https://ai.google.dev/gemini-api/docs/rate-limits                                            |
| Data use                      | **Free tier: content is used to improve Google's products and human reviewers may read inputs and outputs; "Do not submit sensitive, confidential, or personal information."** Paid tier: not used for improvement; logged for a limited time for abuse prevention. EEA/CH/UK: paid terms apply to all services.                                                     | https://ai.google.dev/gemini-api/terms and the pricing page                                  |
| Structured output             | JSON Schema subset: `type`, `title`, `description`, `properties`, `required`, `additionalProperties`, `enum`, `format` (date-time/date/time), `minimum`, `maximum`, `items`, `prefixItems`, `minItems`, `maxItems`; "null" in a type array for nullability. Output is syntactically valid JSON but **can still be semantically wrong**: validate in the application. | https://ai.google.dev/gemini-api/docs/structured-output                                      |
| Error behaviour               | Documented table with `rate_limit_exceeded`/`too_many_requests`/`quota_exceeded` (429), `service_unavailable` (503), `deadline_exceeded` (504), `api_error` (500), etc.; recommended handling is exponential backoff with jitter; **`Retry-After` is not documented**.                                                                                               | https://ai.google.dev/gemini-api/docs/api-errors and /troubleshooting                        |
| Endpoint contract             | Interactions API `POST /v1/interactions` (also `/v1beta`): `model`, `input`, `system_instruction`, `generation_config{max_output_tokens, thinking_level}`, `response_format{type,mime_type,schema}`, `store`; text at `steps[type=model_output].content[type=text].text`. `generateContent` is still documented and shows no deprecation.                            | https://ai.google.dev/api/interactions-api-v1 and https://ai.google.dev/api/generate-content |

### What was observed live, not just read

- **Success path (one call with your key):** exactly the documented shape. `status: "completed"`, a `thought`
  step, then `model_output` with the JSON text; `usage` has `total_input/output/thought_tokens`; no
  `Retry-After` header.
- **A bad key is HTTP 400 `INVALID_ARGUMENT` with `reason: API_KEY_INVALID`, not 401**, and the Interactions
  endpoints sometimes wrap errors in a JSON array. The adapter classifies auth failures by `reason`, not
  only by status, and unwraps arrays. Both captured bodies are used as test fixtures.
- **Error codes can be strings** (`too_many_requests`), not numbers.
- **Latency has a long tail:** the same trivial request took 92 s, 137 s and 4.4 s on `gemini-3.8-flash`; for
  comparison `gemini-3.5-flash-lite` took 2.5 s and `gemini-3.1-flash-lite` 1.7 s; `gemini-3.6-flash`
  answered **429 `too_many_requests`** ("Your project has exceeded a quota"). Those are single samples from
  one project on one afternoon, not benchmarks. **The model was not switched**: the comparison is evidence for
  you to weigh, and the model is one environment variable.

### Decisions

- **Interactions API v1, not `generateContent`.** Every field the pipeline needs (`response_format`,
  `thinking_level`, `max_output_tokens`, `system_instruction`, `store`) was readable in the official text;
  for `generateContent` the thinking configuration was not. `store: false` asks Google not to retain the
  interaction. The API version is a constructor option.
- **Short per-attempt timeout (60 s) plus retry**, because of the latency tail above: abandoning a stuck call
  and retrying recovered in seconds where waiting would have cost minutes. This spends extra requests, so it
  is bounded (3 retries) and configurable.
- **`thinking_level: low`** (the lowest the model accepts) to keep latency and output-token use down.
- **The key travels only in the `x-goog-api-key` header**: never in the URL, body, logs, events or error
  messages (tested, including a provider that echoes the key back). It lives in a non-enumerable property of
  the config object, so JSON, `console.log` and `util.inspect` cannot show it. A missing or malformed key is a
  `MISSING_CREDENTIALS` configuration error and no request is made. Blank env values count as unset.
- **The model never supplies ids, and never decides coverage.** Application code assigns `r1…`, `q1…`, `f1…`
  and the deterministic checker from Phase 2 decides what is covered.
- **Every model item must be grounded.** A requirement is kept only if its quote appears in the posting; a
  brief claim only if its quote appears on the page it cites; ids must exist and be in the category's scope.
  Ungrounded items are dropped and counted, never repaired by guessing. (The repair call is reserved for
  structural problems: invalid JSON, schema violations, truncation.)
- **The posting's own wording overrides the model on must vs nice** ("Nice to have:" headings, "is a plus",
  "required"), because that distinction is worth the most points and is checkable from the text.
- **Separate calls per category with separate requirement subsets** (technical/domain vs behavioural), and
  referenced ids outside a category's scope are dropped, so a technical question cannot claim to cover a
  behavioural requirement.
- **`coverage.passes` counts coverage checks run**, which equals generation passes (the draft, then each gap
  round). Budget 3 (draft plus two rounds); documented in `docs/architecture.md`. A round must shrink the
  **must-have** gaps to earn another pass.
- **Quota exhaustion fails fast and degrades.** Once the provider says the quota is gone, later calls are not
  sent, and a partial, honestly flagged kit is returned. Setup errors (key, model, request shape) stop the run.
  Failure of the role extraction is terminal because nothing can be built without it.
- **Untrusted text is fenced, and fencing is not the defence.** Job postings, pages and forum posts go only
  inside nonce-delimited blocks that the content cannot close; the system prompt says to treat them as data.
  The real defence is validation: an obeyed injection can only produce output that still has to pass grounding.
- **Privacy:** because the free tier may use and have humans read content, the README and `.env.example` say
  so plainly, and pasted job descriptions should not contain confidential or personal data.

### The quota discovery (and what it changed)

The third live run met a real limit: `limit: 20 requests per day on Free Tier` for `gemini-3.8-flash` on
this project (observed 2026-10-19; Google documents no per-model number). Consequences recorded here so
they are not lost:

- **The five-case 15-minute requirement is blocked by quota, not by speed, on this model's free tier.** About
  7 requests a case against 20 a day is about 2 cases. The options (billing at roughly $0.025 a case, a model
  with a larger free allowance, fewer requests per case) are in `docs/architecture.md`; **none was taken**,
  because each is the user's decision (cost, or a different model).
- **A retry-policy bug found by the real service:** a 429 asking for a 20-hour wait was treated as a rate
  limit and the wait was capped to 60 s, so the pipeline retried a hopeless call for about 7 minutes. Fixed
  test-first: a `Retry-After` beyond the limit means give up, and day-scale 429s are `QUOTA_EXHAUSTED`. The
  captured 429 body is a test fixture. Verified live afterwards (0.6 s, one request, a message with the reset time).
- **I used up your free quota while measuring.** Four live runs and several probes consumed the day's 20
  requests on `gemini-3.8-flash`, so the model is unavailable for you until about 20 hours after
  2026-10-19 16:3x local time. That cost is real and was not asked for; the runs were the "explicitly labelled
  smoke test" the brief allowed, but I should have counted requests against a possible daily cap sooner.

### Defects found by measuring (and fixed)

- **Two survivors of mutation checking** exposed weak tests: the prompt's two defusing layers were covered by
  one scenario, and the `INVALID_KIT` guard could not be triggered. Each now has its own test, plus a
  validator seam.
- **A tightened "progress" rule:** the first loop counted covering only a nice-to-have as progress and
  burned the last pass while a must-have stayed open. Progress now means the must-have gaps shrank.
- **An intermittent unhandled rejection in my own Phase 3 integration helper** (`controllableRunner`): a
  rejection issued before the runner started waiting had no handler. Reproduced deterministically first
  (all assertions pass, run exits 1), then fixed with one line, and pinned by a unit test.
- **A shell-quoting slip repeated:** typing `'\\n'` in a heredoc produced a broken test file. The earlier
  note applies: file edits go through the file tools, and I scanned for control characters afterwards.
