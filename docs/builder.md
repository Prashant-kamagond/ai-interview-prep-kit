# The builder: editing, autosave, conflicts and regeneration

Everything here is implemented and covered by tests unless it is listed under **Limitations**. Source:
`packages/contracts/src/builder.ts` (schemas), `packages/core/src/{builder,reconcile,regeneration}.ts` (pure
logic), `packages/pipeline/src/{regenerate,research-snapshot}.ts` (generation side),
`apps/api/src/{services,routes,jobs}` (persistence and jobs), `apps/web/src/features/builder` (the editor).

The Appendix A kit is **not changed** by any of this. Builder metadata lives next to the kit, never
inside it, so a kit is always exactly what Appendix A says it is.

## What the builder remembers

Stored beside each kit (`builder`, validated by `builderStateSchema`):

| Field            | Meaning                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `origin`         | `generated` (made by the pipeline) or `manual` (typed by the user), per question, flashcard and requirement                                                               |
| `edited`         | the user changed a **generated** item's content. A manual item is never "edited": it is the user's own, so the schema rejects that combination                            |
| `pinned`         | regeneration must keep this item exactly as it is. Independent of `edited`. Questions, flashcards, requirements, the brief and schedule days can be pinned                |
| day flags        | per day: `edited`, `pinned`, `focus_manual`, `minutes_manual` (a value the user set is never recalculated)                                                                |
| `tombstones`     | generated items the user deleted: `{kind, id, match_key}`. `match_key` is the item's text, normalised; it is how a regenerated re-wording of a deleted item is recognised |
| `next_ids`       | one ever-growing counter each for `q…`, `f…` and `r…` ids                                                                                                                 |
| `requested_days` | the duration the user asked for. The schedule always has exactly this many days                                                                                           |

**IDs are never reused.** An id is never derived from how many items exist. A counter only goes up, and
the state is rejected as inconsistent if a counter is not above every id present or tombstoned. Deleting
the highest-numbered question therefore cannot free its id. Callers never supply ids; the builder
allocates them.

**Deleting.** Deleting a generated item leaves a tombstone. Deleting a manual item leaves none (it is the
user's own and must never block anything the generator makes later). Deleting a requirement also removes
it from the questions and flashcards that mentioned it (otherwise they would reference nothing).

## Operations

Fifteen pure, atomic operations (`builderOperationSchema`): edit/add/delete for questions, flashcards and
requirements; edit the brief; move a question in the list or to another day; edit a day's focus and
minutes; pin or unpin. Each one validates the input, applies the change to a copy, recomputes derived
values (coverage with the shared `checkCoverage`; focus and minutes of only the days touched, with the
shared schedule allocator, unless the user set them), runs the shared `validateKit` and the state checks,
and returns the new document or a typed error. The input is never mutated.

- **Coverage is derived, never patched.** Deleting the last question for a must-have makes it appear in
  `coverage.uncovered_requirement_ids`. Nothing is ever added back to hide a gap.
- **The number of days is fixed.** There is no operation to add or remove a day: that would change the
  duration the user asked for. (The original whole-kit `PUT` can still change it; see below.)
- Operations are applied through `POST /kits/:id/operations`, all-or-nothing, against a `version`.

## Whole-kit `PUT /kits/:id` keeps the state

`PUT` still replaces the whole kit with the same request, response and status codes. The builder state is
reconciled with the incoming kit (`reconcileWholeKit`) and written in the same update:

1. a known id keeps its provenance and pin; a changed generated item becomes edited;
2. an unknown id is the user's own (manual);
3. a removed generated item leaves a tombstone, a removed manual item leaves none;
4. an incoming item that re-uses a tombstoned id is refused (`409 BUILDER_CONFLICT`);
5. counters never go down; tombstones are never removed;
6. day flags and pins are kept; changed days are flagged; the requested length becomes the incoming
   schedule's length (pins on days that no longer exist go with them).

## Autosave and conflicts (web)

The editor applies each edit **immediately** to a local copy using the same pure functions the server
runs, and saves in the background:

- Edits are queued in order and sent after an 800 ms pause, as one request carrying the server version
  they were made against. At most one request is in flight.
- **Edits made while a save is in flight are never lost:** they join the queue; when the response
  arrives the confirmed operations are retired and the rest are replayed on the confirmed document.
- A failed save keeps every edit and is **never retried automatically**; "Retry saving" resends the same
  operations. A save whose answer was lost is recognised (the server already holds exactly those edits)
  and is not applied twice.
- **Conflicts.** If the server's version has moved on (another tab, a regeneration), the server answers
  `409 VERSION_CONFLICT` with the current document. The editor pauses, keeps the pending edits, says what
  happened and waits. "Reapply my edits" replays them on the new version with the pure builder, all or
  nothing; an edit that no longer applies is named and can be discarded on its own. Nothing is replayed
  or resubmitted without that choice, and the server never replays operations itself.
- **Drafts.** Pending operations are also kept in `sessionStorage` (per kit) so a reload or an expired
  session does not lose them; on the next visit the editor offers to restore them, checking them against
  the kit as it is now and applying none if any no longer fits.
- The browser warns before closing with unsaved edits, and leaving the page sends them.

## Research snapshots

For kits generated after this feature, the research the kit was built from is stored with it
(`research`, validated by `researchSnapshotSchema`) so that a section can be regenerated later without
a new crawl. It holds, exactly as observed:

- per page (at most **12**): address, title, description, role, depth, fetch time, the first
  **4,000** characters of readable text (the generators never show a model more than 3,000), and at most
  **5** interview sentences of at most 500 characters;
- the company URL, the company name the research settled on (or null) and the crawl status;
- at most **8** public discussion posts: address, kind, title and snippet.

Not kept: headings, link counts, hashes, response headers, robots data, failures, raw HTML, and forum
authors, scores and dates. The worst case stays under 150 KB (tested).

**Kits created before this feature have no snapshot, and never will.** The API reports it explicitly
(`research: {status: "unavailable", reason: "not_persisted"}`) and nothing is reconstructed from a summary.

## Section regeneration

`POST /kits/:id/regenerations` with `{section: "brief"}`, `{section: "questions", category}` or
`{section: "schedule"}` returns `202` and a job (`kind: "regenerate"`) that is followed with the ordinary
`GET /generation-jobs/:id`. The job reads the kit once, remembers the version it read, generates, merges
with the pure `applyRegeneration`, and writes kit and state **only if the kit is still at that version**.
A failed regeneration, or one that finds the kit changed, changes nothing.

| Section                  | Needs                                                                                                                      | Model call |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Company brief            | stored research with at least one readable page; the new brief is used only if its claims are verified against those pages | yes        |
| Questions (one category) | the kit's requirements of that category; company-fit questions also need stored company evidence                           | yes        |
| Schedule                 | only the current kit                                                                                                       | no         |

A section whose source is missing is refused **before any job exists** (`422 REGENERATION_UNAVAILABLE`,
with `details.reason`), and a missing source for one section never blocks another: a kit without stored
research can still have its schedule and its technical, behavioural and system-design questions
regenerated. Flashcards cannot be regenerated.

**What is kept.** Manual, edited and pinned questions; generated questions that sit on a pinned day;
every other category; flashcards and requirements; an edited or pinned brief; pinned days, and any focus
or minutes the user set. New questions go to the unpinned day with the fewest questions. Ids come from the
counters. Coverage is recomputed, and unresolved must-haves are reported, not hidden.

**What never comes back.** A candidate whose normalised text equals a tombstone's is dropped. Normalising
means: Unicode-normalise, lower-case, turn every run of non-letters and non-digits into one space.
"Explain the event loop?" matches a deleted "explain the Event-Loop."; an extra word, a different word or a
different order does not, so questions that merely share a phrase are kept. Tombstones are never removed.

**The report** (`job.report`) lists what was kept, replaced, added and skipped (with a reason for each
skip) and the remaining coverage gaps. The editor shows it, loads the regenerated kit only if nothing
unsaved would be lost, and otherwise leaves the user's edits to the conflict workflow above.

Only one regeneration runs per kit at a time (`409 REGENERATION_IN_PROGRESS` with the running job's id);
an identical request joins the running job (`deduplicated: true`). Jobs run in the API process.

## Limitations

- No undo (deleting asks for confirmation first). No operation adds or removes schedule days.
- Drafts live in `sessionStorage`: they survive a reload but not closing the tab.
- While a conflict is unresolved the editor is paused rather than editable.
- A regeneration that is running when the page is reloaded is not re-attached automatically; starting the
  same section again joins it.
- Jobs are in-process: a server restart fails them (`SERVER_RESTARTED`) and they must be resubmitted.
- The kit viewer component (`features/kit`) is still in the repository, but the `/kits/[id]` route now
  shows the editor.
