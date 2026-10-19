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
