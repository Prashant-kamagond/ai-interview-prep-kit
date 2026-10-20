import {
  BUILDER_STATE_VERSION,
  builderOperationSchema,
  builderStateSchema,
  type BuilderOperation,
  type BuilderState,
  type DayMeta,
  type ItemMeta,
  type Kit,
  type Question,
  type TombstoneKind,
} from '@trao/contracts';
import { buildCoverage, checkCoverage } from './coverage';
import { allocateSchedule } from './schedule';
import { validateKit, type ValidationIssue } from './validate';

/**
 * The builder's pure logic. A BuilderDocument is a kit plus its builder state (see
 * `@trao/contracts` builder.ts). Every operation here:
 *
 *   1. checks the document it was given,
 *   2. applies the change to a copy,
 *   3. recomputes what is derived (coverage, and the focus/minutes of the days it touched),
 *   4. runs the shared `validateKit` and the state checks on the result,
 *   5. returns the new document only if all of that passed.
 *
 * Nothing is mutated, nothing is read from a clock or a random source, and a failure returns a typed
 * error instead of a half-applied change, so the same input and operation always give the same output.
 */

export interface BuilderDocument {
  kit: Kit;
  state: BuilderState;
}

export type BuilderErrorCode =
  /** The operation is not one of the supported shapes (unknown type, bad field, nothing to change). */
  | 'INVALID_OPERATION'
  /** The builder state does not match its schema. */
  | 'INVALID_STATE'
  /** Builder state and kit disagree (missing or extra metadata, reused or low counters, ...). */
  | 'STATE_INCONSISTENT'
  /** The kit fails the shared validation rules (the issues are attached). */
  | 'KIT_INVALID'
  /** A whole-kit replacement would bring back an item that was deleted (see reconcile.ts). */
  | 'TOMBSTONE_CONFLICT'
  | 'NOT_FOUND'
  | 'UNKNOWN_REFERENCE'
  | 'INDEX_OUT_OF_RANGE'
  | 'INVALID_ORDER';

export interface BuilderError {
  code: BuilderErrorCode;
  message: string;
  path?: string;
  /** For KIT_INVALID: the error-level issues from validateKit. */
  issues?: ValidationIssue[];
  /** For applyOperations: which operation failed (0-based). */
  operation_index?: number;
}

export type BuilderResult =
  | {
      ok: true;
      document: BuilderDocument;
      /** Legitimate-but-notable states from validateKit, for example an unscheduled question. */
      warnings: ValidationIssue[];
    }
  | { ok: false; error: BuilderError };

const fail = (error: BuilderError): BuilderResult => ({ ok: false, error });

export const ID_PREFIX: Record<TombstoneKind, string> = {
  question: 'q',
  flashcard: 'f',
  requirement: 'r',
};
const MATCH_KEY_MAX = 500;

/** Everything in a document is plain JSON, so this is a faithful deep copy. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The text a regenerated item is compared with: lower case, one space between words. */
export function matchKey(text: string, fallback: string): string {
  const key = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MATCH_KEY_MAX);
  return key === '' ? fallback : key;
}

function idNumber(kind: TombstoneKind, id: string): number | null {
  const m = new RegExp(`^${ID_PREFIX[kind]}(\\d+)$`).exec(id);
  return m ? Number(m[1]) : null;
}

function nextCounter(kind: TombstoneKind, ids: readonly string[]): number {
  return ids.reduce((max, id) => Math.max(max, idNumber(kind, id) ?? 0), 0) + 1;
}

// ---- checking a document --------------------------------------------------------------------

type Check = { ok: true; warnings: ValidationIssue[] } | { ok: false; error: BuilderError };

function sameIdSet(
  kind: string,
  meta: readonly ItemMeta[],
  ids: readonly string[],
): BuilderError | null {
  const seen = new Set<string>();
  for (const m of meta) {
    if (seen.has(m.id)) {
      return {
        code: 'STATE_INCONSISTENT',
        message: `Metadata for ${kind} "${m.id}" appears more than once`,
      };
    }
    seen.add(m.id);
  }
  for (const id of ids) {
    if (!seen.has(id)) {
      return { code: 'STATE_INCONSISTENT', message: `${kind} "${id}" has no builder metadata` };
    }
  }
  const real = new Set(ids);
  for (const id of seen) {
    if (!real.has(id)) {
      return {
        code: 'STATE_INCONSISTENT',
        message: `Builder metadata names ${kind} "${id}", which is not in the kit`,
      };
    }
  }
  return null;
}

/** Checks the kit, the state, and that the two agree. Pure; used before and after every operation. */
export function checkBuilderDocument(doc: BuilderDocument): Check {
  const state = builderStateSchema.safeParse(doc.state);
  if (!state.success) {
    const issue = state.error.issues[0];
    return {
      ok: false,
      error: {
        code: 'INVALID_STATE',
        message: issue?.message ?? 'Invalid builder state',
        path: (issue?.path ?? []).join('.'),
      },
    };
  }
  const s = state.data;

  const validation = validateKit(doc.kit, { requestedDays: s.requested_days });
  if (!validation.ok) {
    return {
      ok: false,
      error: {
        code: 'KIT_INVALID',
        message: 'The kit does not satisfy the required structure',
        issues: validation.issues.filter((i) => i.severity === 'error'),
      },
    };
  }
  const kit = doc.kit;

  const consistency =
    sameIdSet(
      'question',
      s.questions,
      kit.questions.map((q) => q.id),
    ) ??
    sameIdSet(
      'flashcard',
      s.flashcards,
      kit.flashcards.map((f) => f.id),
    ) ??
    sameIdSet(
      'requirement',
      s.requirements,
      kit.role.requirements.map((r) => r.id),
    );
  if (consistency) return { ok: false, error: consistency };

  const dayNumbers = s.days.map((d) => d.day);
  if (dayNumbers.length !== kit.schedule.days.length || dayNumbers.some((d, i) => d !== i + 1)) {
    return {
      ok: false,
      error: {
        code: 'STATE_INCONSISTENT',
        message: 'Day metadata does not match the schedule days',
      },
    };
  }

  const present: Record<TombstoneKind, Set<string>> = {
    question: new Set(kit.questions.map((q) => q.id)),
    flashcard: new Set(kit.flashcards.map((f) => f.id)),
    requirement: new Set(kit.role.requirements.map((r) => r.id)),
  };
  for (const t of s.tombstones) {
    if (present[t.kind].has(t.id)) {
      return {
        ok: false,
        error: {
          code: 'STATE_INCONSISTENT',
          message: `${t.kind} "${t.id}" is both deleted and present`,
        },
      };
    }
  }
  // A counter must be above every id ever used in its family, present or deleted, so no id is reused.
  for (const kind of ['question', 'flashcard', 'requirement'] as const) {
    const used = [
      ...present[kind],
      ...s.tombstones.filter((t) => t.kind === kind).map((t) => t.id),
    ];
    const highest = used.reduce((max, id) => Math.max(max, idNumber(kind, id) ?? 0), 0);
    if (s.next_ids[kind] <= highest) {
      return {
        ok: false,
        error: {
          code: 'STATE_INCONSISTENT',
          message: `The ${kind} id counter (${s.next_ids[kind]}) is not above the highest id used (${ID_PREFIX[kind]}${highest})`,
        },
      };
    }
  }

  return { ok: true, warnings: validation.issues.filter((i) => i.severity === 'warning') };
}

/**
 * Starts a builder document from a kit that came from the generator (or any valid kit). Every item is
 * recorded as generated, unedited and unpinned. `requestedDays` defaults to the kit's own length.
 */
export function createBuilderDocument(
  input: unknown,
  options: { requestedDays?: number } = {},
): BuilderResult {
  const first = validateKit(input);
  if (!first.ok || !first.kit) {
    return fail({
      code: 'KIT_INVALID',
      message: 'The kit does not satisfy the required structure',
      issues: first.issues.filter((i) => i.severity === 'error'),
    });
  }
  const kit = clone(first.kit);
  const meta = (id: string): ItemMeta => ({
    id,
    origin: 'generated',
    edited: false,
    pinned: false,
  });
  const state: BuilderState = {
    version: BUILDER_STATE_VERSION,
    requested_days: options.requestedDays ?? kit.schedule.days_available,
    next_ids: {
      question: nextCounter(
        'question',
        kit.questions.map((q) => q.id),
      ),
      flashcard: nextCounter(
        'flashcard',
        kit.flashcards.map((f) => f.id),
      ),
      requirement: nextCounter(
        'requirement',
        kit.role.requirements.map((r) => r.id),
      ),
    },
    questions: kit.questions.map((q) => meta(q.id)),
    flashcards: kit.flashcards.map((f) => meta(f.id)),
    requirements: kit.role.requirements.map((r) => meta(r.id)),
    brief: { edited: false, pinned: false },
    days: kit.schedule.days.map((d): DayMeta => ({
      day: d.day,
      edited: false,
      pinned: false,
      focus_manual: false,
      minutes_manual: false,
    })),
    tombstones: [],
  };
  const doc = { kit, state };
  const checked = checkBuilderDocument(doc);
  if (!checked.ok) return { ok: false, error: checked.error };
  return { ok: true, document: doc, warnings: checked.warnings };
}

// ---- applying an operation ------------------------------------------------------------------

function notFound(what: string, id: string | number): BuilderError {
  return { code: 'NOT_FOUND', message: `${what} "${id}" does not exist` };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Working copy plus the bookkeeping an operation needs. */
class Draft {
  readonly kit: Kit;
  readonly state: BuilderState;
  /** Days whose calculated focus/minutes must be refreshed at the end. */
  readonly affected = new Set<number>();

  constructor(doc: BuilderDocument) {
    this.kit = clone(doc.kit);
    this.state = clone(doc.state);
  }

  question(id: string): Question | undefined {
    return this.kit.questions.find((q) => q.id === id);
  }

  meta(list: 'questions' | 'flashcards' | 'requirements', id: string): ItemMeta {
    const found = this.state[list].find((m) => m.id === id);
    if (!found) throw new Error(`missing metadata for ${id}`); // unreachable: checked beforehand
    return found;
  }

  /** The user changed a generated item. Manual items are the user's own, so the flag stays false. */
  markEdited(list: 'questions' | 'flashcards' | 'requirements', id: string): void {
    const m = this.meta(list, id);
    if (m.origin === 'generated') m.edited = true;
  }

  dayMeta(day: number): DayMeta {
    const found = this.state.days.find((d) => d.day === day);
    if (!found) throw new Error(`missing metadata for day ${day}`);
    return found;
  }

  dayOf(questionId: string): number | null {
    return this.kit.schedule.days.find((d) => d.question_ids.includes(questionId))?.day ?? null;
  }

  daysReferencing(requirementId: string): number[] {
    const questionIds = new Set(
      this.kit.questions.filter((q) => q.requirement_ids.includes(requirementId)).map((q) => q.id),
    );
    return this.kit.schedule.days
      .filter((d) => d.question_ids.some((id) => questionIds.has(id)))
      .map((d) => d.day);
  }

  allocate(kind: TombstoneKind): string {
    const n = this.state.next_ids[kind];
    this.state.next_ids[kind] = n + 1;
    return `${ID_PREFIX[kind]}${n}`;
  }

  unknownRequirement(ids: readonly string[]): string | undefined {
    const known = new Set(this.kit.role.requirements.map((r) => r.id));
    return ids.find((id) => !known.has(id));
  }

  tombstone(kind: TombstoneKind, id: string, text: string, origin: ItemMeta['origin']): void {
    // Only generated items are remembered: a deleted manual item is the user's own and must never
    // block anything the generator makes later.
    if (origin === 'generated')
      this.state.tombstones.push({ kind, id, match_key: matchKey(text, id) });
  }
}

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Recomputes the focus and minutes of the given days, except where the user set them. The shared
 * allocator, asked about one day, supplies the same focus and minutes it would have produced for
 * these questions; nothing about the policy is repeated here.
 */
export function refreshAutoDays(kit: Kit, state: BuilderState, days: Iterable<number>): void {
  const byId = new Map(kit.questions.map((q) => [q.id, q]));
  for (const dayNo of [...days].sort((a, b) => a - b)) {
    const day = kit.schedule.days.find((d) => d.day === dayNo);
    const meta = state.days.find((d) => d.day === dayNo);
    if (!day || !meta) continue;
    if (meta.focus_manual && meta.minutes_manual) continue;
    const questions = day.question_ids.flatMap((id) => {
      const q = byId.get(id);
      return q ? [q] : [];
    });
    const auto = allocateSchedule({ days: 1, questions, requirements: kit.role.requirements })
      .days[0];
    if (!auto) continue;
    if (!meta.focus_manual) day.focus = auto.focus;
    if (!meta.minutes_manual) day.minutes = auto.minutes;
  }
}

function refreshDays(draft: Draft): BuilderError | null {
  refreshAutoDays(draft.kit, draft.state, draft.affected);
  return null;
}

function mutate(draft: Draft, op: BuilderOperation): BuilderError | null {
  const { kit, state } = draft;
  switch (op.type) {
    case 'edit_question': {
      const q = draft.question(op.id);
      if (!q) return notFound('Question', op.id);
      const c = op.changes;
      let changed = false;
      if (c.requirement_ids !== undefined) {
        const ids = dedupe(c.requirement_ids);
        const bad = draft.unknownRequirement(ids);
        if (bad !== undefined) {
          return {
            code: 'UNKNOWN_REFERENCE',
            message: `Requirement "${bad}" does not exist`,
            path: 'changes.requirement_ids',
          };
        }
        if (!sameList(ids, q.requirement_ids)) {
          q.requirement_ids = ids;
          changed = true;
        }
      }
      if (c.prompt !== undefined && c.prompt !== q.prompt) {
        q.prompt = c.prompt;
        changed = true;
      }
      if (c.answer_outline !== undefined && c.answer_outline !== q.answer_outline) {
        q.answer_outline = c.answer_outline;
        changed = true;
      }
      if (c.difficulty !== undefined && c.difficulty !== q.difficulty) {
        q.difficulty = c.difficulty;
        changed = true;
      }
      if (c.category !== undefined && c.category !== q.category) {
        q.category = c.category;
        changed = true;
      }
      if (changed) {
        draft.markEdited('questions', q.id);
        const day = draft.dayOf(q.id);
        if (day !== null) draft.affected.add(day);
      }
      return null;
    }

    case 'add_question': {
      const q = op.question;
      const refs = dedupe(q.requirement_ids);
      const bad = draft.unknownRequirement(refs);
      if (bad !== undefined) {
        return {
          code: 'UNKNOWN_REFERENCE',
          message: `Requirement "${bad}" does not exist`,
          path: 'question.requirement_ids',
        };
      }
      let target = op.day;
      if (target !== undefined && !kit.schedule.days.some((d) => d.day === target)) {
        return notFound('Day', target);
      }
      if (target === undefined) {
        target = kit.schedule.days.reduce(
          (best, d) => (d.question_ids.length < best.question_ids.length ? d : best),
          kit.schedule.days[0]!,
        ).day;
      }
      const id = draft.allocate('question');
      kit.questions.push({
        id,
        requirement_ids: refs,
        category: q.category,
        prompt: q.prompt,
        answer_outline: q.answer_outline,
        difficulty: q.difficulty,
      });
      state.questions.push({ id, origin: 'manual', edited: false, pinned: false });
      kit.schedule.days.find((d) => d.day === target)!.question_ids.push(id);
      draft.dayMeta(target).edited = true;
      draft.affected.add(target);
      return null;
    }

    case 'delete_question': {
      const q = draft.question(op.id);
      if (!q) return notFound('Question', op.id);
      const origin = draft.meta('questions', q.id).origin;
      const day = draft.dayOf(q.id);
      kit.questions = kit.questions.filter((x) => x.id !== q.id);
      state.questions = state.questions.filter((m) => m.id !== q.id);
      for (const d of kit.schedule.days)
        d.question_ids = d.question_ids.filter((id) => id !== q.id);
      draft.tombstone('question', q.id, q.prompt, origin);
      if (day !== null) {
        draft.dayMeta(day).edited = true;
        draft.affected.add(day);
      }
      return null;
    }

    case 'move_question': {
      const from = kit.questions.findIndex((q) => q.id === op.id);
      if (from === -1) return notFound('Question', op.id);
      if (op.to_index >= kit.questions.length) {
        return {
          code: 'INDEX_OUT_OF_RANGE',
          message: `Position ${op.to_index} is outside 0 to ${kit.questions.length - 1}`,
          path: 'to_index',
        };
      }
      const [moved] = kit.questions.splice(from, 1);
      kit.questions.splice(op.to_index, 0, moved!);
      return null;
    }

    case 'edit_flashcard': {
      const f = kit.flashcards.find((x) => x.id === op.id);
      if (!f) return notFound('Flashcard', op.id);
      const c = op.changes;
      let changed = false;
      if (c.requirement_ids !== undefined) {
        const ids = dedupe(c.requirement_ids);
        const bad = draft.unknownRequirement(ids);
        if (bad !== undefined) {
          return {
            code: 'UNKNOWN_REFERENCE',
            message: `Requirement "${bad}" does not exist`,
            path: 'changes.requirement_ids',
          };
        }
        if (!sameList(ids, f.requirement_ids)) {
          f.requirement_ids = ids;
          changed = true;
        }
      }
      if (c.front !== undefined && c.front !== f.front) {
        f.front = c.front;
        changed = true;
      }
      if (c.back !== undefined && c.back !== f.back) {
        f.back = c.back;
        changed = true;
      }
      if (changed) draft.markEdited('flashcards', f.id);
      return null;
    }

    case 'add_flashcard': {
      const refs = dedupe(op.flashcard.requirement_ids);
      const bad = draft.unknownRequirement(refs);
      if (bad !== undefined) {
        return {
          code: 'UNKNOWN_REFERENCE',
          message: `Requirement "${bad}" does not exist`,
          path: 'flashcard.requirement_ids',
        };
      }
      const id = draft.allocate('flashcard');
      kit.flashcards.push({
        id,
        front: op.flashcard.front,
        back: op.flashcard.back,
        requirement_ids: refs,
      });
      state.flashcards.push({ id, origin: 'manual', edited: false, pinned: false });
      return null;
    }

    case 'delete_flashcard': {
      const f = kit.flashcards.find((x) => x.id === op.id);
      if (!f) return notFound('Flashcard', op.id);
      const origin = draft.meta('flashcards', f.id).origin;
      kit.flashcards = kit.flashcards.filter((x) => x.id !== f.id);
      state.flashcards = state.flashcards.filter((m) => m.id !== f.id);
      draft.tombstone('flashcard', f.id, f.front, origin);
      return null;
    }

    case 'edit_brief': {
      const c = op.changes;
      let changed = false;
      if (c.summary !== undefined && c.summary !== kit.company_brief.summary) {
        kit.company_brief.summary = c.summary;
        changed = true;
      }
      if (c.what_they_do !== undefined && c.what_they_do !== kit.company_brief.what_they_do) {
        kit.company_brief.what_they_do = c.what_they_do;
        changed = true;
      }
      if (changed) state.brief.edited = true;
      return null;
    }

    case 'edit_requirement': {
      const r = kit.role.requirements.find((x) => x.id === op.id);
      if (!r) return notFound('Requirement', op.id);
      const c = op.changes;
      let changed = false;
      if (c.text !== undefined && c.text !== r.text) {
        r.text = c.text;
        changed = true;
      }
      if (c.kind !== undefined && c.kind !== r.kind) {
        r.kind = c.kind;
        changed = true;
      }
      if (c.priority !== undefined && c.priority !== r.priority) {
        r.priority = c.priority;
        changed = true;
      }
      if (changed) {
        draft.markEdited('requirements', r.id);
        // Day focus text is built from requirement text and priority.
        for (const day of draft.daysReferencing(r.id)) draft.affected.add(day);
      }
      return null;
    }

    case 'add_requirement': {
      const id = draft.allocate('requirement');
      kit.role.requirements.push({ id, ...op.requirement });
      state.requirements.push({ id, origin: 'manual', edited: false, pinned: false });
      return null; // no question covers it yet: the gap is reported by the coverage recomputation
    }

    case 'delete_requirement': {
      const r = kit.role.requirements.find((x) => x.id === op.id);
      if (!r) return notFound('Requirement', op.id);
      const origin = draft.meta('requirements', r.id).origin;
      for (const day of draft.daysReferencing(r.id)) draft.affected.add(day);
      kit.role.requirements = kit.role.requirements.filter((x) => x.id !== r.id);
      state.requirements = state.requirements.filter((m) => m.id !== r.id);
      // References to a requirement that no longer exists would make the kit invalid, so they go too.
      // Those questions and flashcards were not edited by the user, so they are not marked edited.
      for (const q of kit.questions)
        q.requirement_ids = q.requirement_ids.filter((id) => id !== r.id);
      for (const f of kit.flashcards)
        f.requirement_ids = f.requirement_ids.filter((id) => id !== r.id);
      draft.tombstone('requirement', r.id, r.text, origin);
      return null;
    }

    case 'edit_day_focus': {
      const day = kit.schedule.days.find((d) => d.day === op.day);
      if (!day) return notFound('Day', op.day);
      if (day.focus !== op.focus) {
        day.focus = op.focus;
        const meta = draft.dayMeta(op.day);
        meta.focus_manual = true;
        meta.edited = true;
      }
      return null;
    }

    case 'edit_day_minutes': {
      const day = kit.schedule.days.find((d) => d.day === op.day);
      if (!day) return notFound('Day', op.day);
      const meta = draft.dayMeta(op.day);
      if (op.minutes === null) {
        if (meta.minutes_manual) {
          meta.minutes_manual = false;
          meta.edited = true;
          draft.affected.add(op.day);
        }
      } else if (day.minutes !== op.minutes || !meta.minutes_manual) {
        day.minutes = op.minutes;
        meta.minutes_manual = true;
        meta.edited = true;
      }
      return null;
    }

    case 'move_question_to_day': {
      if (!draft.question(op.question_id)) return notFound('Question', op.question_id);
      const target = kit.schedule.days.find((d) => d.day === op.to_day);
      if (!target) return notFound('Day', op.to_day);
      const fromDay = draft.dayOf(op.question_id);
      const source = kit.schedule.days.find((d) => d.day === fromDay);
      const before = source ? source.question_ids.indexOf(op.question_id) : -1;
      if (source) source.question_ids = source.question_ids.filter((id) => id !== op.question_id);
      const index = op.index ?? target.question_ids.length;
      if (index > target.question_ids.length) {
        return {
          code: 'INDEX_OUT_OF_RANGE',
          message: `Position ${index} is outside 0 to ${target.question_ids.length}`,
          path: 'index',
        };
      }
      target.question_ids.splice(index, 0, op.question_id);
      if (fromDay === op.to_day && before === index) return null; // put back where it was: nothing changed
      for (const d of [fromDay, op.to_day]) {
        if (d === null) continue;
        draft.dayMeta(d).edited = true;
        draft.affected.add(d);
      }
      return null;
    }

    case 'set_pin': {
      const t = op.target;
      switch (t.kind) {
        case 'question':
          if (!draft.question(t.id)) return notFound('Question', t.id);
          draft.meta('questions', t.id).pinned = op.pinned;
          return null;
        case 'flashcard':
          if (!kit.flashcards.some((f) => f.id === t.id)) return notFound('Flashcard', t.id);
          draft.meta('flashcards', t.id).pinned = op.pinned;
          return null;
        case 'requirement':
          if (!kit.role.requirements.some((r) => r.id === t.id))
            return notFound('Requirement', t.id);
          draft.meta('requirements', t.id).pinned = op.pinned;
          return null;
        case 'day':
          if (!kit.schedule.days.some((d) => d.day === t.day)) return notFound('Day', t.day);
          draft.dayMeta(t.day).pinned = op.pinned;
          return null;
        case 'brief':
          state.brief.pinned = op.pinned;
          return null;
      }
    }
  }
}

/**
 * Applies one operation atomically. On success the returned document is a new object (the input is
 * never touched); on failure the typed error says why and nothing was applied.
 */
export function applyOperation(doc: BuilderDocument, input: unknown): BuilderResult {
  const before = checkBuilderDocument(doc);
  if (!before.ok) return { ok: false, error: before.error };

  const parsed = builderOperationSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail({
      code: 'INVALID_OPERATION',
      message: issue?.message ?? 'Invalid operation',
      path: (issue?.path ?? []).join('.'),
    });
  }

  const draft = new Draft(doc);
  const failure = mutate(draft, parsed.data) ?? refreshDays(draft);
  if (failure) return fail(failure);

  // Coverage is derived: it is always recomputed from the questions as they now are, never patched.
  // A must-have left without a question therefore shows up in `uncovered_requirement_ids`.
  draft.kit.coverage = buildCoverage(
    checkCoverage(draft.kit.role.requirements, draft.kit.questions),
    draft.kit.coverage.passes,
  );

  const after = checkBuilderDocument({ kit: draft.kit, state: draft.state });
  if (!after.ok) return { ok: false, error: after.error };
  return { ok: true, document: { kit: draft.kit, state: draft.state }, warnings: after.warnings };
}

/** Applies several operations in order, all or nothing. The error names the operation that failed. */
export function applyOperations(
  doc: BuilderDocument,
  operations: readonly unknown[],
): BuilderResult {
  let current = doc;
  let warnings: ValidationIssue[] = [];
  for (const [index, op] of operations.entries()) {
    const result = applyOperation(current, op);
    if (!result.ok) return fail({ ...result.error, operation_index: index });
    current = result.document;
    warnings = result.warnings;
  }
  if (operations.length === 0) {
    const checked = checkBuilderDocument(doc);
    if (!checked.ok) return { ok: false, error: checked.error };
    warnings = checked.warnings;
  }
  return { ok: true, document: current, warnings };
}

/** Minutes per day and in total, as the schedule currently states them. */
export function scheduleTotals(kit: Kit): {
  per_day: { day: number; minutes: number }[];
  total_minutes: number;
} {
  const per_day = kit.schedule.days.map((d) => ({ day: d.day, minutes: d.minutes }));
  return { per_day, total_minutes: per_day.reduce((sum, d) => sum + d.minutes, 0) };
}
