# Architecture notes

Sections are added as each phase lands. Only implemented behaviour is described as implemented.

## Backend (`apps/api`) — implemented in Phase 3

Layered as routes → services → repositories → MongoDB, with cross-cutting middleware. Full
endpoint, error, session, concurrency, job-lifecycle and index documentation is in
[`api.md`](api.md).

```text
request ─► requestContext ─► helmet ─► CORS allow-list ─► Origin check ─► JSON(1 MB) ─► cookies
        ─► [health] ─► rate limit ─► routes ─► 404 ─► errorHandler (single place errors become JSON)

routes/        HTTP only: parse with contracts schemas, call a service, shape the response
services/      auth, kits (validation + concurrency policy), jobs (lifecycle + dedup + runner)
repositories/  the only code that touches collections; every kit/job query filters by owner
jobs/          pure state machine and input hash; JobRunner interface (the Phase 5/6 seam)
security/      argon2id password hashing, session token generation and keyed hashing
```

The `JobRunner` interface is the seam for the real pipeline: Phase 6 supplies an implementation
that calls `packages/pipeline`. Until then the default runner fails jobs honestly.

## Deterministic core (`packages/core`) — implemented in Phase 2

Pure functions, no I/O, no model calls. The API and the batch CLI import the same code.

### Kit validation — `validateKit(input, { requestedDays })`

1. Structure: parse with the shared Zod `kitSchema` (Appendix A). Any failure returns
   `SCHEMA_INVALID` issues with a path such as `questions[0].difficulty`; reference checks are
   skipped because the data cannot be trusted yet.
2. Invariants, in a fixed order so output is repeatable:
   unique ids per collection · every question and flashcard `requirement_ids` entry resolves ·
   every scheduled `question_ids` entry resolves · `days.length === days_available` · days numbered
   `1..N` · `days_available === requestedDays` · no question scheduled twice · every must-have that
   has a question is in a scheduled question · `coverage.uncovered_requirement_ids` equals what the
   questions actually leave uncovered.
3. Severity: `error` makes the kit invalid. `UNSCHEDULED_QUESTION` is a `warning`, because a
   hand-added question is legitimately unscheduled until the schedule is regenerated.

### Coverage — `checkCoverage(requirements, questions)`

A requirement is covered when some question lists its id. Results follow requirement order, unknown
references are reported but never count, and uncovered must-haves are listed separately.

**How the Phase 5 second-pass loop will use it** (orchestration lives in `packages/pipeline`, not in
core):

```text
draft questions (one call per category)
  └─ pass 1: report = checkCoverage(...)
       ├─ no uncovered ids → done
       └─ else: generate questions for exactly report.uncovered_requirement_ids, append,
          pass 2: checkCoverage again … repeat until clean or the pass budget is spent
done → coverage = buildCoverage(report, passesRun)
```

`passes` counts coverage checks run. Proposed budget: 3 (the draft plus two gap-filling rounds).
Rationale: a gap that survives two targeted attempts is rarely fixed by a third, while each pass
costs tokens on a rate-limited free tier. This number is finalised and justified in Phase 5.
Anything still uncovered stays in `coverage.uncovered_requirement_ids` and is shown in the UI.

### Schedule — `allocateSchedule({ days, questions, requirements })`

1. Rank questions: touches a must-have → difficulty (3→1) → number of must-haves covered → original
   order. The final tie-break makes the result deterministic.
2. Cut the ranked list into `days` contiguous chunks whose sizes differ by at most one, larger
   chunks first, so the hardest and highest-priority material is on the earliest days.
3. Every question is placed exactly once, so every must-have that has a question is scheduled.
4. Minutes are integers: 10/15/20 per question by difficulty, summed per day. With fewer questions
   than days, the surplus days hold no questions and are 30-minute "Review and mock practice" days
   (this also covers a sparse kit and the 60-day case). Focus is derived from the day's leading
   question: its category plus its must-have requirement text.

Known limits: durations are estimates, not measured effort; a must-have with no question cannot be
scheduled and is reported through coverage instead; there is no upper bound on `days` in core (the
API enforces the accepted range in Phase 3).

## Research engine (`packages/pipeline`) — implemented in Phase 4

Nothing calls it yet: the API's job runner still fails every job with `PIPELINE_NOT_IMPLEMENTED`.
Phase 6 wires `researchCompany()` into the shared pipeline. Everything below is covered by tests that
use local fixture servers (no live sites, no live search service); the manual live check is described
at the end.

```text
researchCompany(input, config)
  ├─ crawlCompanySite ── validateUrl → robots.txt → fetch company URL → best-first loop:
  │     polite fetcher (per-host spacing, bounded retries, deadline)
  │       └─ safe fetch (validated + pinned DNS, redirect re-validation, size/type/time limits)
  │     parse5 extraction → rank links → classify page → dedupe → enqueue in-scope links
  ├─ inferCompanyName (only if no name was given; marked inferred)
  └─ DiscussionProvider.search ── HN Algolia provider (the only provider)
```

### SSRF-resistant fetching (`safe-fetch.ts`, `network-policy.ts`, `ip-policy.ts`)

- **URL checks:** only `http`/`https`; no embedded credentials; length ≤ 2048; ports 80, 443, 8080,
  8443 only; IP literals are classified before any request (WHATWG URL already normalises decimal,
  hex and octal IPv4 forms such as `http://2130706433/`); names like `localhost`, `*.local`,
  `*.internal` are refused.
- **Address classification** is table-driven. Public means globally routable unicast. Loopback,
  RFC 1918, link-local (including the `169.254.169.254` metadata address), CGNAT, multicast,
  documentation, benchmarking, 6to4/NAT64/Teredo and other reserved ranges are refused;
  IPv4-mapped IPv6 is classified by the IPv4 address it wraps; IPv6 outside `2000::/3` is refused;
  anything unparseable is refused.
- **DNS pinning:** the connection uses a custom `lookup` that resolves the name once, checks **every**
  answer (one private address rejects the whole answer), and hands that same validated address to
  the socket. Node never resolves the name a second time, so a rebinding answer cannot redirect the
  connection. The request keeps `hostname` (correct `Host` header), and for HTTPS `servername` is the
  hostname, so SNI and certificate verification are against the real name; `rejectUnauthorized` is
  never overridden. IP-literal hosts skip DNS and are validated up front.
- **Redirects:** followed manually, at most 5; every hop is re-validated (scheme, credentials, port,
  literal address, and — through the same pinned lookup — resolved addresses) and a caller-supplied
  guard can restrict scope (the crawler allows only the site itself). https→http downgrades are
  refused. A redirect into a forbidden place is reported as `REDIRECT_BLOCKED`.
- **Bounds:** one total deadline across all hops, a socket idle timeout, content-type allow-list
  (`text/html`, `application/xhtml+xml` for pages), a byte limit applied both to wire bytes and to
  decompressed bytes (gzip/deflate; `br` is not accepted), and an oversize policy: `reject`
  (default) or `truncate` (keep the first N bytes and mark the result truncated). Destroying the
  streams on oversize means a decompression bomb is never read to the end.
- **No ambient credentials:** the header set is fixed (`User-Agent`, `Accept`, `Accept-Encoding`,
  `Accept-Language`, `Connection`). No cookies, no `Authorization`, no proxy settings, no pooled
  sockets (`agent: false`).
- **Loopback fixtures (development, tests, batch):** `createNetworkPolicy({ loopbackHosts })` takes
  explicit `host:port` pairs and permits loopback addresses for exactly those pairs. It does not
  unlock private ranges, metadata addresses, other loopback ports or other hosts, so a public site
  redirecting to `127.0.0.1:<other port>` is still refused. `createResearchPolicy` builds the list
  from the company URL itself and only if that URL really is on loopback. Creating a policy with a
  loopback list while `NODE_ENV=production` throws, and the API's config separately refuses
  `ALLOW_PRIVATE_HOSTS=true` in production.

### robots.txt and politeness (`robots.ts`, `polite-fetcher.ts`, `clock.ts`, `retry.ts`)

- RFC 9309 semantics: groups by `User-agent` (our token `TraoPrepBot` beats `*`), longest matching
  pattern wins and `Allow` wins ties, `*` and `$` wildcards, `Crawl-delay` honoured exactly.
- **4xx on robots.txt means "none": nothing restricted** (RFC 9309). **5xx, 429, timeouts and network
  failures mean "unreachable": nothing is crawled**, and the limitation is recorded. robots.txt is read
  once per host (subdomains have their own) and re-checked for the final URL after a redirect.
- Per host: one request in flight, ≥ 1 second between starts (raised to the site's `Crawl-delay`).
  Retries: up to 3, exponential backoff with equal jitter (0.5 s base, 8 s cap), `Retry-After` honoured
  up to 10 s, only for timeouts, connection errors and HTTP 429/500/502/503/504, never past the
  research deadline.
- Honest `User-Agent`: `TraoPrepBot/0.1 (interview-preparation research; honours robots.txt)`.
- robots.txt is a politeness convention. It is not an access control, not a substitute for the SSRF
  protections, and **site terms of service are not machine-checked** by anything here.

### Crawling, ranking and hiring-page detection (`crawler.ts`, `link-ranking.ts`, `hiring.ts`)

- **Budgets per run (defaults):** 12 pages, depth 3, 3 MB per page (larger pages are read in part and
  marked `truncated`, not rejected), 15 s per request, 90 s total (80% for the crawl, the rest for the
  discussion search).
- **Scope:** the root host (`www` ignored) and its subdomains (so `careers.acme.com` is reachable from
  `acme.com`), never a parent, sibling, look-alike (`evilacme.com`) or external site. IP-literal and
  `localhost` roots mean that exact host. Scope is by host and port, not by path prefix.
- **Never fetched:** assets (images, CSS/JS, PDFs, archives, feeds…), login/logout/sign-up/account/
  cart/admin paths, `rel=nofollow` links, links on pages with `<meta name=robots content=nofollow>`.
- **Discovery has no fixed path list.** Links come from the fetched pages (relative URLs, `../`,
  protocol-relative, `<base href>` all resolved), are deduplicated by a normalised key (scheme,
  `www`, fragment, trailing slash, `index.html`, tracking parameters ignored) and scored
  deterministically from anchor text, `title`/`aria-label`, URL path words, placement (nav/header/
  footer) and nearby text. Whole-word phrase matching only (`carpet` is not `career`). The crawler
  fetches the best-scoring unfetched link next.
- **Pages are judged by their own content**, because anchors are unpredictable: title, headings, URL,
  listing cues ("open positions", "apply now") and interview-process cues ("take-home", "system
  design", "recruiter screen"). Roles: `home`, `about`, `hiring`, `hiring-process`, `other`. If nothing
  qualifies the result says `hiring.found: false` and adds a limitation; nothing is invented.
- **Observed vs inferred:** `title`, `headings`, `text` and `interview_mentions` (sentences quoted
  verbatim from the page) are observed. `role`, `classification` and `hiring` are heuristic
  inferences and carry their evidence.
- **Untrusted content:** pages are parsed with parse5 and never executed or rendered; script, style,
  template, SVG and hidden content are dropped; text that looks like instructions stays inert text
  (tested). Substantially duplicate pages are dropped by exact hash and by 5-word-shingle Jaccard ≥ 0.9.

### Public discussion search — decision record

- **Provider:** the Hacker News Algolia Search API (`https://hn.algolia.com/api/v1/search`), no key.
- **Not used, deliberately:** Reddit's unauthenticated public JSON endpoints and DuckDuckGo HTML are not
  scraped. The provider sits behind `DiscussionProvider` so another source can be added later if
  authorised access exists; none is added now.
- **Verified by one manual call:** hits carry `objectID`, `title`, `url`, `author`, `points`,
  `created_at`, `story_id`, and `story_text` or `comment_text` (HTML-escaped); an empty result is HTTP 200
  with `hits: []`; quoted phrases are supported. **Not verified:** the documentation page is rendered
  client-side and could not be read, and I could not confirm any published rate limit. The usage
  budget is therefore conservative rather than derived from a limit: at most 2 queries per company,
  ≥ 1 s between requests, 8 s timeout, bounded retries with `Retry-After`, no follow-up query after a
  429, at most 8 results.
- **Results:** real `news.ycombinator.com/item?id=…` URLs, titles, ISO timestamps, and a snippet that
  is a verbatim passage of the post (HTML removed) near the interview mention. Status is `ok`,
  `no_results` (an honest empty result) or `unavailable` (with an error code); it is never fatal.
- **Relevance filtering (heuristic):** the post's own text must use interview vocabulary — a strong
  phrase ("interview process", "take-home", "onsite", "interviewed at"…), or a bare "interview" with
  hiring words within 15 words — and the company must be named near it (or in the thread title).
  Posts in "Who is hiring?" and "Who wants to be hired?" threads are excluded (job ads, not
  discussion). Precision is imperfect: see limitations.

### Result shape

`researchCompany` returns `{ researched_at, company: {name, name_source, inferred}, crawl, discussion,
pages_used, discussion_urls, limitations }`. `pages_used` maps to Appendix A `source.pages_used`;
`limitations` is the plain-language list of everything that could not be done or found. It never throws
because a site is down, blocked, empty or hostile.

### Live check (manual, once, not part of the test suite)

`posthog.com` and `about.gitlab.com` were crawled with the production-strict policy (12 pages, ~13 requests
each, 13–15 s). Both hiring-process pages were found by following links, with no fixed paths:
`/handbook/people/hiring-process` (PostHog) and `/jobs/ai-interview-process/` (GitLab). The first run
exposed two defects that the fixtures had not: real homepages exceed 1 MB (so the whole site was
reported unreachable) and the discussion filter admitted job ads and "user interviews". Both were fixed
and re-checked. After the fix GitLab's discussion results were mostly genuine candidate accounts (about
4 of 8 clearly, the rest marginal) and PostHog's were weaker (about 2 of 6 clearly). Treat discussion
snippets as leads, not findings.

### Known limitations of the research layer

- **TLS:** pinning and hostname verification are asserted by checking the options passed to
  `https.request`; a real handshake against a self-signed or mismatched certificate is **not** tested.
- **No JavaScript rendering:** single-page apps whose content arrives via script yield thin pages and
  possibly no hiring page. Meta-refresh and script redirects are not followed.
- **English-only heuristics:** hiring and interview vocabularies are English; other languages will
  often yield `hiring.found: false`.
- **Only HTML pages are read** (`text/html`, `application/xhtml+xml`); PDFs and other types are
  recorded as failures. Sites that require cookies or a login are not supported.
- **Subdomains** of the root host are in scope without a cap on how many distinct subdomains are
  visited (each costs a robots.txt request); the page budget bounds the total.
- **Company-name inference** is a guess from the site (marked `inferred`); a generic or ambiguous name
  ("Scale", "Square") weakens the discussion search.
- **Discussion coverage is Hacker News only**, which skews towards tech companies and may find nothing.
- **Site terms of service are not checked**; robots.txt compliance is not legal advice.
- Prompt-injection defence is only half done here (page text is kept inert and quoted verbatim);
  Phase 5 must still fence it inside prompts and validate every model output.

## AI generation pipeline (`packages/pipeline`) — implemented in Phase 5

**Not wired in yet:** the API job runner still fails jobs with `PIPELINE_NOT_IMPLEMENTED` and
`npm run evaluate` still exits 2. Phase 6 connects `researchCompany()` → `generateKit()`. The pieces below
are tested with a fake provider (no network, no credentials) and were also run live against Gemini with
`pnpm llm:smoke`.

```text
generateKit({ jd, days, research }, { llm })
  1  extractRequirements            1 call   terminal if it fails: nothing can be built without it
  2  ┬ generateCompanyBrief         1 call   no call if no page has text (deterministic honest brief)
     ├ questions:technical         1 call ┐
     ├ questions:behavioural       1 call ├ run concurrently, up to LLM_MAX_CONCURRENCY
     └ questions:system-design     1 call ┘
  3  questions:company-fit         1 call   needs the brief; skipped when there is no company evidence
  4  closeCoverageGaps             0–4 calls  the deterministic checker decides; at most 2 gap rounds
  5  generateFlashcards            1 call
  6  allocateSchedule + validateKit   no model: arithmetic, then the Phase 2 validator on the whole kit
```

**Model calls per case:** typically **7**; the minimum is **1** (an empty posting with no research: nothing to
ask about); the practical maximum is 7 plus up to 4 gap-fill calls, plus at most one repair per call and up to
3 retries per attempt, all bounded. Coverage and the schedule never use the model.

### The model proposes, application code decides

Every model reply is JSON validated by a Zod schema (and, for Gemini, sent as a schema restricted to the
documented subset: `llm/json-schema.ts` refuses anything else). The model is never asked for ids.

| Stage                               | Kept only if…                                                                                                                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requirements                        | its **quote appears in the posting** (whole words, ignoring case/punctuation); its restatement stays close to the quote (else the quote is used); duplicates merged; ids `r1…` assigned **in posting order**                        |
| must / nice                         | the posting's own cue wins: inline wording ("is a plus", "bonus", "required", "must") first, then the nearest heading ("Nice to have:", "Requirements:"); a neutral heading ends the search; otherwise the model's judgement stands |
| Title, seniority, location, company | every word appears in the posting, else `""` (unknown)                                                                                                                                                                              |
| Brief claims                        | the cited URL is a page that was fetched **and the quote appears on that page**; URLs in prose that were not supplied are removed; with no verified claim the prose is discarded for the website's own meta description             |
| Questions                           | ids exist **and are in the category's scope**; a question with no valid id is dropped (except company-fit); duplicates dropped; count capped                                                                                        |
| Flashcards                          | at least one real requirement id; duplicates dropped; capped                                                                                                                                                                        |
| Kit                                 | `validateKit` (Phase 2) passes, including: references resolve, schedule has exactly the requested days, every covered must-have is scheduled, `coverage` matches the questions                                                      |

Ungrounded items are dropped and **counted** (`extras.dropped`), never "fixed" by guessing. The repair call is
reserved for structural problems (invalid JSON, schema violation, truncation) and is limited to one.

### Sparse and empty inputs

A posting under 25 words is flagged `sparse`; the kit is thin and says so. A model that pads a stub with
invented requirements has them dropped (their quotes are not in the posting). An empty posting makes no call.
A category with nothing to ask about (for example no behavioural requirements) makes no call; company-fit is
skipped without company evidence. A site that could not be fetched yields a brief that says exactly that and
cites nothing.

### The second pass (`stages/coverage-loop.ts`)

1. The draft questions are checked by `checkCoverage` (pure code in `@trao/core`): pass 1.
2. If a **must-have** has no question, one gap round runs: the uncovered requirements (plus uncovered
   nice-to-haves, which ride along) are grouped by kind (technical/domain vs behavioural) and each group
   gets one targeted generation call that may only reference those ids.
3. Coverage is recomputed from the questions' ids after every round. A model's claim of success counts for
   nothing; references to ids that do not exist count for nothing.
4. **Stops** when: all must-haves are covered (`covered`, or `only-nice-uncovered` with no further spend); a
   round did not reduce the **must-have** gaps (`no-progress`); the budget is spent (`budget`); the model
   cannot be used (`failed`); or there are no requirements.

**`coverage.passes` counts the deterministic coverage checks that were run.** Each check follows exactly one
generation pass (the initial draft, then each completed gap round), so it is also the number of generation
passes: `1` means the draft already covered everything, `2` means one gap round closed the gaps. The budget is
**3** (the draft plus at most two rounds). A gap that survives two targeted attempts is rarely closed by a
third, while every pass costs latency and tokens on a rate-limited free tier. Anything still uncovered stays in
`coverage.uncovered_requirement_ids`, the kit's `status` is `incomplete` with the ids in
`incompleteReasons`, and `limitations` says so. The kit never claims coverage it does not have.

### Failure states (all distinguishable)

| Code                                                               | Meaning                                                          | Behaviour                                                                                                                                                                            |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MISSING_CREDENTIALS`                                              | no or malformed `LLM_API_KEY`                                    | configuration error before any request                                                                                                                                               |
| `AUTH_FAILED`, `MODEL_NOT_FOUND`, `INVALID_REQUEST`                | key rejected, model unavailable, request shape rejected          | stop the run; never retried; the model is never substituted                                                                                                                          |
| `QUOTA_EXHAUSTED`                                                  | per-day or credit quota gone                                     | no further calls are sent; a partial, flagged kit is returned                                                                                                                        |
| `BUDGET_EXHAUSTED`                                                 | the run's time budget is used up                                 | same                                                                                                                                                                                 |
| `RATE_LIMITED`, `TIMEOUT`, `PROVIDER_UNAVAILABLE`, `NETWORK_ERROR` | transient                                                        | bounded retries (3) with exponential backoff and jitter, honouring `Retry-After` / `RetryInfo` up to a cap and never past the deadline; then that stage fails and the kit is flagged |
| `INVALID_OUTPUT`, `OUTPUT_TRUNCATED`                               | model JSON failed validation / was cut off                       | one repair attempt, then that stage fails                                                                                                                                            |
| `CONTENT_BLOCKED`                                                  | provider declined the content                                    | not retried                                                                                                                                                                          |
| `INVALID_KIT`                                                      | internal: the assembled kit failed `validateKit`                 | terminal, with issue codes and paths                                                                                                                                                 |
| _(status `incomplete`)_                                            | a must-have is still uncovered, or a stage failed or was skipped | a result, not an error                                                                                                                                                               |

Messages come from a fixed table. Provider wording is kept only as a redacted, 300-character `detail` for
server logs. Events and statistics carry metadata only (stage, attempt, outcome, tokens, durations): never
prompts, replies or keys.

### Reliability and limits

Per-attempt timeout 60 s (`LLM_REQUEST_TIMEOUT_MS`), shortened to the time left before the run's deadline;
3 retries; concurrency 2; optional `LLM_MIN_INTERVAL_MS` pacing; output tokens capped per stage and globally
(16,384); thinking level `low`. Once a quota error is seen, later calls fail fast without being sent. Every
setting is an environment variable documented in `.env.example`. **No RPM/TPM/RPD figure is assumed:** Google
publishes none per model; read yours in Google AI Studio.

### Prompt-injection posture

Untrusted text (the posting, crawled pages, forum comments, and text derived from them) appears only inside
delimited data blocks whose markers carry a random nonce and cannot be closed from the inside; the system
prompt, which holds the task and rules, contains no untrusted text (tested). The system prompt tells the model
to treat the blocks as data and never to follow or reveal instructions. **That is a first defence, not the
guarantee.** The guarantee is validation: a model that obeys an injected instruction can only emit output that
must still pass grounding, id and URL checks (tested with a model that obeys: fabricated requirements,
citations, URLs and ids never reach the kit).

### Data use and privacy

The posting and page text are sent to Google. On the **free tier Google may use them to improve its products
and human reviewers may read them**; the paid tier does not. Do not use confidential or personal data. The
request sets `store: false`.

### Measured with the real model (`pnpm llm:smoke`, 2026-10-19, `gemini-3.8-flash`, one project)

| Run | Input                                                                | Requests       | Retries | Tokens in / out | Wall clock | Result                                        |
| --- | -------------------------------------------------------------------- | -------------- | ------- | --------------- | ---------- | --------------------------------------------- |
| 1   | sample posting + sample research                                     | 10 (7 logical) | 3       | 5,337 / 5,040   | 152 s      | complete kit                                  |
| 2   | same                                                                 | 7              | 0       | 5,387 / 5,523   | 49 s       | complete kit                                  |
| 3   | synthetic posting + a **live crawl of posthog.com** (12 pages, 14 s) | 18 (8 logical) | 10      | 6,190 / 1,760   | 445 s      | **incomplete: free-tier daily quota hit**     |
| 4   | sample                                                               | 1              | 0       | n/a             | 0.6 s      | `QUOTA_EXHAUSTED`, "resets in about 20 hours" |

Runs 1 and 2 produced a complete, valid kit: 8 requirements with the right must/nice split, 17–18 questions in
all four categories, 12 flashcards, coverage complete at pass 1, a 5-day schedule. Individual calls took 5–16 s.
**A normal case is 7 requests, about 5.4k input and 5.5k output tokens, and about a minute.**

#### The free-tier quota finding (observed live, not in Google's documentation)

Run 3 stopped getting answers part-way. A direct probe returned HTTP 429 with:

> `Rate limit exceeded for model gemini-3.8-flash (limit: 20 requests per day on Free Tier). Please retry in 19h57m49s or upgrade your tier at https://ai.dev/rate-limit.`

and `Retry-After: 71869`. So **for this project, on this date, the free tier of `gemini-3.8-flash` allowed 20
requests per day**, which my four runs and probes used up. Google publishes no per-model limits, so this
figure is an observation about one key, not a documented constant, and **nothing in the code assumes it**;
read your own limits in Google AI Studio.

What this means:

- **The five-case, 15-minute batch requirement cannot be met on this model's free tier.** One case needs about
  7 requests, so 20 per day is about 2 cases; five cases need about 35. This is a quota fact, not a latency
  one, and no amount of optimisation inside the free quota changes it.
- **What the pipeline did when it hit the limit was right:** no crash, a valid kit, `status: incomplete`, the
  uncovered must-haves (`r3`, `r4`) named, every failed stage listed, no invented content.
- **What it did _wrongly_ was a bug, now fixed:** the daily limit arrived as an ordinary 429 (string code, no
  `QuotaFailure` details), so it was classified as a retryable rate limit and the client _shortened_ the
  20-hour wait to 60 s and retried, spending about 7 minutes on calls that could not succeed. Now (a) a 429
  that mentions a daily limit, carries a `QuotaFailure` for a per-day quota, or asks for more than 15 minutes
  is `QUOTA_EXHAUSTED` and is not retried, and (b) in general, a `Retry-After` longer than the configured
  maximum means _give up_, not _wait less_. Verified live afterwards: the same exhausted quota now fails in
  0.6 s with one request.

Options to reach five cases (the choice and any cost are yours; none has been taken):

1. **Enable billing on the AI Studio project** (paid tier). Per Google's pricing page, `gemini-3.8-flash`
   costs $0.75 per million input and $3.75 per million output tokens through 2026-12-31 ($1.50 and $7.50
   after). At about 5.4k input and 5.5k output tokens a case, that is **about $0.025 a case, about $0.12 for five
   cases** (an arithmetic estimate from the measured token counts, not a billing record). The paid terms also
   mean content is not used to improve Google's products.
2. **Use a model with a larger free daily allowance.** `gemini-3.5-flash-lite` and `gemini-3.1-flash-lite`
   answered normally in 1.7 and 2.5 s. I did not probe their daily limits, because finding a limit means using
   it up; check them in AI Studio. Changing model is one environment variable (`LLM_MODEL`), but the model
   was not changed here, and output quality on a smaller model is unmeasured.
3. **Fewer requests per case.** Flashcards could be produced inside the category calls (6 requests instead of
   7). That alone gets about 3 cases a day, not 5.

Case-level concurrency and batching do not reduce the request count, so they do not help with a daily quota.

### Known limitations of the generation layer

- **The five-case requirement is not met on the free tier and is not verified at all.** Latency would allow it
  (about a minute a case); the daily request quota would not (see above). It has not been run end to end
  with a real model. Phase 6 added a per-case deadline and sequential batch processing; neither bypasses a quota.
- **Quality is judged by structure and grounding, not by an expert.** Two of the live questions in the
  company-fit category read like system-design questions; the schema cannot prevent that.
- **Brief prose is not verified sentence by sentence.** Only the claims behind it carry quotes. A model could
  write a sentence no claim supports; the validated claims make the brief auditable, not infallible.
- **Quote matching is exact on words.** A model that paraphrases its quote loses a legitimate item (it is
  counted and reported).
- **Thinking tokens were reported as 0** in the live runs although the earlier probe showed some; usage fields
  are taken as reported by the API.
- **English-oriented prompts and heuristics.**
- **Only Gemini is implemented.** The `LlmProvider` interface is the seam for another.

## Case runner and batch (`packages/pipeline`, `scripts/evaluate.ts`) — implemented in Phase 6

One function, `runCase(input, deps)` in `run-case.ts`, takes `{jd, company_url, days}` and either returns a
validated Appendix A kit or throws a `CaseFailure` with a stable code and a curated message. The API's
generation job (`apps/api/src/jobs/pipeline-runner.ts`) and the batch command both call it and nothing else,
so they cannot drift apart. A parity test runs the same input through both and compares the kits.

```text
validate input (same schema as the API) ─► research the company site ─► model client with the case deadline
        │                                        │                              │
   INVALID_INPUT                    no page at all? ─► COMPANY_* failure     generateKit (Phase 5)
                                    some pages? ─► continue, gaps recorded       │
                                                                  GenerationFailure ─► LLM_* / DEADLINE_EXCEEDED / KIT_INVALID
```

### Failure versus a limited kit

| Situation                                                                  | Result                                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Invalid input (days outside 1-60, empty description, non-http URL)         | failed `INVALID_INPUT` (in a batch file: `INVALID_CASE`)                          |
| URL syntax invalid or carries credentials                                  | failed `COMPANY_URL_INVALID`                                                      |
| URL points at a private, loopback or metadata address (SSRF policy)        | failed `COMPANY_URL_BLOCKED`                                                      |
| Nothing answers, or only errors / 404                                      | failed `COMPANY_UNREACHABLE`                                                      |
| `robots.txt` cannot be fetched at all (RFC 9309: treated as off limits)    | failed `COMPANY_UNREACHABLE` (a site that is down, not one that forbids us)       |
| `robots.txt` forbids the whole site                                        | failed `COMPANY_BLOCKED_BY_ROBOTS`                                                |
| At least one page was retrieved, no hiring page, no discussion, thin site  | **ok**: a limited kit, with the brief limited to what was found                   |
| A model stage fails part-way (rate limit, quota, timeout) after extraction | **ok**, incomplete: valid kit with fewer questions/flashcards, gaps in `coverage` |
| Extraction itself fails, or the model setup is wrong                       | failed `LLM_*` (the kit cannot be built without the role breakdown)               |
| Time runs out before extraction                                            | failed `DEADLINE_EXCEEDED`                                                        |

Rule behind the table: a company brief is never invented, so a site that yields no page at all is a
failure with a code that says why; anything that yields some pages produces an honestly limited kit. A
kit that came out incomplete is never labelled complete: `runCase` returns `status`, `incompleteReasons` and
`limitations`, the batch command prints them per case, and the API logs them.

**Contract limit.** Appendix A (and the job record) has no field for limitations or an "incomplete" status
and extra keys would be dropped by validation, so those details cannot travel inside the kit. What the kit
itself shows honestly: `coverage.uncovered_requirement_ids`, the number of questions and flashcards, and the
brief text. Adding an optional field needs a contract change and was not made.

### Deadlines

- **Per case: 90 s** for research and generation together (`EVALUATE_CASE_DEADLINE_MS`; `caseDeadlineMs` for
  the API). The model client enforces it: no call starts after it, and a call in flight ends at its own
  timeout, which is capped by the time left.
- **Conflict with the research engine's default, resolved per call.** The research engine's default total
  budget is 90 s, equal to the whole case budget. `runCase` therefore passes research a budget of 40% of the
  case budget (36 s of 90 s) for that call; the engine's defaults are unchanged. If research uses the whole of
  its share the model still has about 54 s.
- **Per batch: 14 minutes** (`EVALUATE_BATCH_DEADLINE_MS`), finite. Cases run one at a time, in input order;
  a case that cannot start before the deadline is recorded `BATCH_DEADLINE_EXCEEDED`, and the running case's
  own deadline is capped by what is left of the batch.
- **Arithmetic for the five-case requirement:** worst case 5 x 90 s = 450 s, inside the 840 s batch budget and
  the assignment's 15 minutes (900 s). Sequential processing therefore supports the target in the worst case,
  provided each case stays within its 90 s budget. More than nine cases that each use the whole budget would
  not fit in 14 minutes, and the last ones would be recorded as `BATCH_DEADLINE_EXCEEDED`.

### The batch command

`scripts/evaluate.ts` parses arguments, reads the file (`readBatchInput`), calls `runBatch`, and writes the
result with `writeBatchOutput` (temporary file in the same folder, then a rename; validated against
`batchOutputSchema` first). Every input entry yields exactly one output entry in order: a malformed entry is
keyed by its id, or by its position when it has none; a duplicate id is failed `DUPLICATE_ID`; each kit is
checked against Appendix A again before it is reported `ok`. Exit codes: 0 output written (even if cases
failed), 1 unexpected, 2 arguments, 3 input, 4 configuration, 5 output.

Local company sites: `createResearchPolicy` permits loopback for exactly the case URL's own host and port (so
`http://localhost:8099/acme/` works with relative links) and throws in production. A case cannot reach another
local port or any private range (tested: a fixture whose page links to a second local server never causes a
request to it).

### Measured (2026-10-20)

Five synthetic cases, local fixture sites, the deterministic fake model (no live request of any kind), run
through the real `runCli`: **26.3 s in total, 5.3 s a case, 35 model calls (7 a case)** with the research
engine's default politeness (1 s between requests to one host); **0.06 s** without politeness (the unit test).
This measures the pipeline's own overhead and the crawl, not a model. With a real model the time is dominated
by model latency (observed about a minute a case on Gemini when not throttled) and quota; **five real cases in
15 minutes has not been demonstrated.**

### Known limitations of the case runner

- Limitations and incompleteness cannot be stored in the kit (see "Contract limit").
- Cases run sequentially; there is no case-level concurrency. It would not help a daily request quota.
- After a provider quota failure the next case still makes one request to discover it (each case builds its
  own client); it fails fast.
- A completed identical API request still creates a new job and a new kit.
- A job's 90 s budget is not yet configurable through the API's environment.
