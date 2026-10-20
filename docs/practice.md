# Practice mode

The assignment (section 7) asks for four things. This is what implements each, and what was decided where
the assignment leaves room. Source: `packages/contracts/src/practice.ts` (schemas),
`packages/core/src/practice.ts` (ordering and coverage, pure), `apps/api/src/{repositories,services,routes}/practice.ts`
(storage), `apps/web/src/features/practice` (the screens). Open it from a kit with **Practise flashcards**
(`/kits/[id]/practice`).

| Requirement                                                    | How it is met                                                                                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step through flashcards one at a time, revealing the answer    | One card is on screen. Its answer is **not in the page** until the user presses "Show answer" (a test checks that the text is absent from the document before then).            |
| Record how confident they felt on each card                    | After the answer is shown, three buttons: **Not confident** (1), **Somewhat confident** (2), **Confident** (3). The rating is stored by the server before the session moves on. |
| Show what has been covered and what has not                    | On the start screen and at the end: "Covered: 3 of 8 cards; 5 not covered yet", the cards not covered (listed), and the covered cards by their latest confidence.               |
| Order the next session by what they were least confident about | A confidence-weighted sort, described and defended below.                                                                                                                       |

## Choices the assignment leaves open

**The scale.** The assignment names none. Three levels keep the choice quick on a phone and are enough for
the ordering; the labels describe recall ("I did not know it / I knew part of it / I knew it") rather than
a feeling, so a rating means the same thing on a different day.

**Covered.** A card is _covered_ once it has been rated at least once, ever. Skipping a card ("Skip this card
for now", available only before the answer is shown) records nothing, so it stays uncovered, and the end
screen says how many were skipped.

**Ordering: a confidence-weighted sort, not spaced repetition.** The next session lists every card in
this order (`orderForPractice`):

1. cards never rated first (nothing is known about them, which is less than "not confident", and they are
   exactly the cards not yet covered);
2. then by the **latest** confidence, lowest first (1, then 2, then 3);
3. within a confidence, the card practised **longest ago** first;
4. otherwise the kit's own order, so the result is stable and repeatable.

Why this and not an interval scheduler. It does what the assignment literally asks, it is easy to explain
to a user ("you will see what you are least sure of first"), it needs one small record per card and no
due dates, and it is a pure function with exhaustive tests. Spaced repetition would also decide _when_
to show a card, which needs a notion of "due today" and a clock the user can understand; for a kit studied
over a handful of days that is more machinery than it earns. Why the _latest_ rating and not an average:
it reflects what the user knows now, so a card they finally got right stops coming first. The cost: one
lucky answer demotes a card. Every card is always included; the order says what to do first and the user
decides when to stop.

## What is stored, and what it is not

Progress **persists** (the next session's order depends on earlier sessions, so it has to). Per user, per
kit, per card, one record in the `practice_cards` collection: the latest confidence, the number of ratings,
the time of the latest, and the id of the latest rating (see below). Nothing else: no answers typed by the
user, no timings, no profile data, and nothing is sent to a language model.

- **Ownership.** Every endpoint loads the kit as the signed-in user first; a kit that is missing and a kit
  that belongs to someone else are the same `404`. A card must be in that kit (`404` otherwise). Progress is
  never readable or writable across users.
- **Duplicates.** A rating carries an `attempt_id` made by the browser for one press of a button. A repeat
  of the same id (a retry after a lost response, a double click, ten simultaneous copies) is recorded once:
  the update only matches a record whose latest attempt is a different one, and a unique index on
  `(userId, kitId, cardId)` settles races. The response says `duplicate: true`.
- **The session never loses a rating.** The session moves to the next card only after the server confirmed
  the save. If the save fails, the card, its answer and the chosen rating stay on screen with "Try saving
  again", which resends the same attempt. A second press while saving is ignored.
- **When the kit changes.** Progress for a flashcard that was deleted is not reported and cannot be added
  to; ids are never reused, so progress cannot attach to a different card. Editing a card keeps its rating
  (it is the same card). A card added later is simply not covered yet. Deleting a kit deletes its progress.
- **Restart.** "Practise again" starts a new session, ordered from the saved progress. "Reset my progress"
  (with confirmation) deletes the saved progress for that kit (`DELETE /kits/:id/practice`).

## Endpoints

| Method | Path                               | Notes                                                                                           |
| ------ | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| GET    | `/kits/:id/practice`               | `200 {kit_id, cards:[{card_id, confidence, attempts, last_practised_at}]}`                      |
| PUT    | `/kits/:id/practice/cards/:cardId` | Body `{confidence: 1\|2\|3, attempt_id}`. `200 {card, duplicate}`. `400` invalid, `404` unknown |
| DELETE | `/kits/:id/practice`               | `204`. Forgets this kit's progress for the signed-in user                                       |

All need a session; `PUT` and `DELETE` need the `Origin` header like every unsafe request.

## Accessibility

Native buttons throughout; the confidence choices are a labelled group; focus moves to the card (then to
the answer when it is shown, then to the next card, then to "Session complete"); progress is a labelled
`<progress>` and changes are announced politely ("Card 2 of 8", "Answer shown", "Saved: Confident",
"Session complete"). The layout is a single column that works at phone width.

## Limitations

- Progress is per kit and per account. There is no cross-kit review and no "only cards below confident"
  filter: the order puts them first and the user stops when ready.
- No keyboard shortcuts beyond normal tabbing and activation.
- Verified with component tests (jsdom) and API integration tests against MongoDB; not yet in a real
  browser.
