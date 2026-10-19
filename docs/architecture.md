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
