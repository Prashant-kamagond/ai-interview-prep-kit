# Demo plan

**Status: planned, not recorded.** Nothing below has been executed as a demo or filmed. The walkthrough video
(3 to 4 minutes) has to be recorded by you. This is a script that matches what the assignment asks the video
to cover. Parts marked _check_ say what to look at; none of the outcomes has been observed in a browser.

## Two ways to prepare

**Deterministic (no key, no network).** The tests are the repeatable evidence for the pipeline, including the
second pass that closes a coverage gap. They use a fake model and local fixture company sites:

```bash
pnpm test                                    # unit tests, no database
pnpm test:integration                        # real MongoDB (make db first)
pnpm vitest run packages/pipeline/src/batch.test.ts
pnpm vitest run scripts/evaluate.test.ts     # the batch command, failure codes, output file
```

There is no switch that runs the web app itself against a fake model, and none is added on purpose (a model
override in the server would be a way to bypass the real provider in production).

**Live (your key, uses quota).** For the video the app has to generate for real: set `LLM_API_KEY` in your own
`.env`, then `make db` and `pnpm dev`. The free quota is small (README, "LLM provider"), so
rehearse with one case and a short schedule, and do not run the five-case batch right before filming.

## Script (about 3.5 minutes)

| Time | Show                                                                                                                               | Say / check                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 0:00 | Sign up and create a kit: paste a job description, a company URL, choose days                                                      | Research then generation; the progress view names the stages                                          |
| 0:45 | The finished kit: brief, role breakdown, questions by category, flashcards, schedule                                               | Coverage: every must-have requirement has questions; the `coverage` summary; the pages that were read |
| 1:15 | The second pass: point at a kit whose first pass left a gap, or explain from `docs/architecture.md`                                | Coverage is checked in code, not by the model; uncovered requirements trigger a targeted second pass  |
| 1:30 | Builder: edit a question, add one, reorder, pin one, move a schedule item                                                          | Autosave; edited and pinned items are marked                                                          |
| 2:15 | Regenerate one question category                                                                                                   | Edited and pinned items are kept, replaced ones are generated; show the result                        |
| 2:45 | Practice mode: rate cards, show the order change and the coverage                                                                  | Least-confident first; the schedule days                                                              |
| 3:15 | One design decision to defend, for example: coverage and schedule allocation are deterministic code, the model only writes content | See `docs/development-decisions.md`                                                                   |
| 3:40 | (Optional) the batch command: `npm run evaluate -- --input cases.json --output kits.json`                                          | Appendix B output; a failing case does not stop the run                                               |

No custom creative feature was added, so none is shown. Say so rather than presenting practice mode as one.

## Before recording

- Rehearse once with the same inputs; keep the key out of the screen (do not show `.env` or the terminal
  environment).
- Use a company URL whose site allows crawling (the crawler obeys `robots.txt`).
- If the deployed app is used, the deployment must exist first ([`deployment.md`](deployment.md)); it does not
  yet.
