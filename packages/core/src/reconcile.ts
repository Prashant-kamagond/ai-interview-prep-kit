import {
  BUILDER_STATE_VERSION,
  type BuilderState,
  type DayMeta,
  type ItemMeta,
  type Kit,
  type TombstoneKind,
} from '@trao/contracts';
import {
  checkBuilderDocument,
  createBuilderDocument,
  type BuilderDocument,
  type BuilderResult,
} from './builder';
import { validateKit } from './validate';

/**
 * Whole-kit replacement (the original `PUT /kits/:id`) on a kit that has builder state.
 *
 * The incoming kit says what the kit should now contain; the builder state says what is known about
 * how it got there. The two are reconciled by these rules, so a whole-kit save neither resets the
 * builder metadata nor lets the kit and the state drift apart:
 *
 *  1. An item (question, flashcard, requirement) whose id is already known keeps its provenance and
 *     its pin. If its content differs from what was stored and it was generated, it becomes edited.
 *  2. An item with an id the state has never seen is the user's own: it becomes manual.
 *  3. An item that is no longer present is deleted: a generated one leaves a tombstone, a manual one
 *     does not (exactly as the delete operations behave).
 *  4. An incoming item may not reuse the id of a tombstoned (deleted) item. That would silently undo a
 *     deletion, so the whole request is refused with TOMBSTONE_CONFLICT.
 *  5. Counters never go down: each becomes the larger of the stored counter and one above the
 *     highest id now in the kit or in any tombstone.
 *  6. Tombstones are all kept.
 *  7. The brief becomes edited if its text changed; pins are kept.
 *  8. A day keeps its pin and flags. A day whose focus, minutes or questions differ from what was stored
 *     is marked edited (focus_manual / minutes_manual when those values changed). The requested length
 *     becomes the incoming schedule's length, because a whole-kit save has always been allowed to
 *     decide it; pins on days that no longer exist go with them.
 *
 * The result is checked with the same checks as every other builder operation before it is returned.
 */

const ID_PREFIX: Record<TombstoneKind, string> = {
  question: 'q',
  flashcard: 'f',
  requirement: 'r',
};

function idNumber(kind: TombstoneKind, id: string): number {
  const m = new RegExp(`^${ID_PREFIX[kind]}(\\d+)$`).exec(id);
  return m ? Number(m[1]) : 0;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Rules 1-3 for one family of items. `content` is what counts as the item's content. */
function reconcileItems<T extends { id: string }>(
  oldItems: readonly T[],
  oldMeta: readonly ItemMeta[],
  newItems: readonly T[],
  content: (item: T) => unknown,
): { meta: ItemMeta[]; removed: { item: T; origin: ItemMeta['origin'] }[] } {
  const oldById = new Map(oldItems.map((i) => [i.id, i]));
  const metaById = new Map(oldMeta.map((m) => [m.id, m]));
  const meta = newItems.map((item): ItemMeta => {
    const known = metaById.get(item.id);
    if (!known) return { id: item.id, origin: 'manual', edited: false, pinned: false };
    const before = oldById.get(item.id);
    const changed = before !== undefined && !same(content(before), content(item));
    return {
      ...known,
      edited: known.origin === 'generated' && (known.edited || changed),
    };
  });
  const kept = new Set(newItems.map((i) => i.id));
  const removed = oldItems
    .filter((i) => !kept.has(i.id))
    .map((item) => ({ item, origin: metaById.get(item.id)?.origin ?? 'generated' }));
  return { meta, removed };
}

export function reconcileWholeKit(current: BuilderDocument, incoming: unknown): BuilderResult {
  const before = checkBuilderDocument(current);
  if (!before.ok) return { ok: false, error: before.error };

  const first = validateKit(incoming);
  if (!first.ok || !first.kit) {
    return {
      ok: false,
      error: {
        code: 'KIT_INVALID',
        message: 'The kit does not satisfy the required structure',
        issues: first.issues.filter((i) => i.severity === 'error'),
      },
    };
  }
  const kit: Kit = JSON.parse(JSON.stringify(first.kit)) as Kit;
  const old = current.kit;
  const state = current.state;

  const questions = reconcileItems(
    old.questions,
    state.questions,
    kit.questions,
    ({ id: _id, ...rest }) => rest,
  );
  const flashcards = reconcileItems(
    old.flashcards,
    state.flashcards,
    kit.flashcards,
    ({ id: _id, ...rest }) => rest,
  );
  const requirements = reconcileItems(
    old.role.requirements,
    state.requirements,
    kit.role.requirements,
    ({ id: _id, ...rest }) => rest,
  );

  // Rule 4: nothing deleted may come back under its old id.
  const tombstoned = new Set(state.tombstones.map((t) => `${t.kind}:${t.id}`));
  const revived: string[] = [];
  const present: Record<TombstoneKind, string[]> = {
    question: kit.questions.map((q) => q.id),
    flashcard: kit.flashcards.map((f) => f.id),
    requirement: kit.role.requirements.map((r) => r.id),
  };
  for (const kind of ['question', 'flashcard', 'requirement'] as const) {
    for (const id of present[kind])
      if (tombstoned.has(`${kind}:${id}`)) revived.push(`${kind} ${id}`);
  }
  if (revived.length > 0) {
    return {
      ok: false,
      error: {
        code: 'TOMBSTONE_CONFLICT',
        message: `The kit contains items that were deleted earlier and may not return under the same id: ${revived.join(', ')}`,
        path: 'tombstones',
      },
    };
  }

  const tombstones = [...state.tombstones];
  const remember = (kind: TombstoneKind, id: string, text: string, origin: ItemMeta['origin']) => {
    if (origin !== 'generated') return;
    const key = text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 500);
    tombstones.push({ kind, id, match_key: key === '' ? id : key });
  };
  for (const { item, origin } of questions.removed)
    remember('question', item.id, item.prompt, origin);
  for (const { item, origin } of flashcards.removed)
    remember('flashcard', item.id, item.front, origin);
  for (const { item, origin } of requirements.removed)
    remember('requirement', item.id, item.text, origin);

  const next_ids = { ...state.next_ids };
  for (const kind of ['question', 'flashcard', 'requirement'] as const) {
    const used = [...present[kind], ...tombstones.filter((t) => t.kind === kind).map((t) => t.id)];
    const highest = used.reduce((max, id) => Math.max(max, idNumber(kind, id)), 0);
    next_ids[kind] = Math.max(state.next_ids[kind], highest + 1); // never lowered
  }

  const briefChanged =
    old.company_brief.summary !== kit.company_brief.summary ||
    old.company_brief.what_they_do !== kit.company_brief.what_they_do;

  const days: DayMeta[] = kit.schedule.days.map((day) => {
    const prior = state.days.find((d) => d.day === day.day);
    const oldDay = old.schedule.days.find((d) => d.day === day.day);
    if (!prior || !oldDay) {
      return {
        day: day.day,
        edited: true,
        pinned: false,
        focus_manual: false,
        minutes_manual: false,
      };
    }
    const focusChanged = oldDay.focus !== day.focus;
    const minutesChanged = oldDay.minutes !== day.minutes;
    const questionsChanged = !same(oldDay.question_ids, day.question_ids);
    return {
      ...prior,
      edited: prior.edited || focusChanged || minutesChanged || questionsChanged,
      focus_manual: prior.focus_manual || focusChanged,
      minutes_manual: prior.minutes_manual || minutesChanged,
    };
  });

  const merged: BuilderState = {
    version: BUILDER_STATE_VERSION,
    requested_days: kit.schedule.days_available,
    next_ids,
    questions: questions.meta,
    flashcards: flashcards.meta,
    requirements: requirements.meta,
    brief: { edited: state.brief.edited || briefChanged, pinned: state.brief.pinned },
    days,
    tombstones,
  };

  const document: BuilderDocument = { kit, state: merged };
  const after = checkBuilderDocument(document);
  if (!after.ok) return { ok: false, error: after.error };
  return { ok: true, document, warnings: after.warnings };
}

/**
 * The builder document for a kit that has no state yet (made before the builder existed). Every item
 * is recorded as generated and unedited, because nothing says otherwise. This is deterministic, so two
 * requests that initialise the same kit at the same time compute the same state.
 */
export function initializeBuilderState(kit: unknown): BuilderResult {
  return createBuilderDocument(kit);
}
