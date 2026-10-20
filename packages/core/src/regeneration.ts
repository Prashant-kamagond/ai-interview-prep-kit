import {
  regenerationApplySchema,
  type BuilderState,
  type Kit,
  type Question,
  type RegenerationApply,
  type RegenerationReport,
  type Tombstone,
} from '@trao/contracts';
import {
  ID_PREFIX,
  checkBuilderDocument,
  refreshAutoDays,
  type BuilderDocument,
  type BuilderError,
} from './builder';
import { buildCoverage, checkCoverage } from './coverage';
import { allocateSchedule } from './schedule';
import type { ValidationIssue } from './validate';

/**
 * Merging regenerated material into a kit.
 *
 * The generator decides WHAT is proposed; this module decides what the kit keeps. It is pure and
 * deterministic, works on a copy, recomputes coverage with the shared functions, and returns the new
 * document only if the shared checks pass, exactly like every builder operation.
 *
 * What is never replaced:
 *   - items the user typed (manual), changed (edited) or pinned;
 *   - questions on a pinned day, because that day's allocation is pinned;
 *   - anything outside the requested section.
 * What never comes back:
 *   - an item whose normalised text equals a tombstone (see `tombstoneMatches`).
 * Ids come from the persistent counters, which only ever grow.
 */

export type RegenerationResult =
  | {
      ok: true;
      document: BuilderDocument;
      report: RegenerationReport;
      warnings: ValidationIssue[];
    }
  | { ok: false; error: BuilderError };

/**
 * The comparison key used for tombstones: Unicode-normalised, lower-cased, every run of anything that
 * is not a letter or a digit collapsed to one space. So "Explain the event loop?" equals
 * "  explain the   Event-Loop ", while a question with an extra or a different word does not: only
 * the same words in the same order match. Two different questions that merely share a phrase, or mean
 * the same thing in other words, are different questions and are kept.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Whether `text` is the item a tombstone recorded as deleted. */
export function tombstoneMatches(text: string, tombstone: Pick<Tombstone, 'match_key'>): boolean {
  const candidate = normalizeForMatch(text);
  // An empty comparison key (text made only of symbols) would match every other such text.
  return candidate !== '' && candidate === normalizeForMatch(tombstone.match_key);
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const fail = (error: BuilderError): RegenerationResult => ({ ok: false, error });

function emptyReport(
  section: RegenerationReport['section'],
  category: RegenerationReport['category'],
): RegenerationReport {
  return {
    section,
    category,
    kept: [],
    replaced: [],
    added: [],
    skipped: [],
    days: null,
    gaps: { uncovered_must_ids: [], uncovered_ids: [] },
  };
}

function finish(kit: Kit, state: BuilderState, report: RegenerationReport): RegenerationResult {
  // Coverage is derived, never patched: a must-have left without a question shows up as uncovered.
  const coverage = checkCoverage(kit.role.requirements, kit.questions);
  kit.coverage = buildCoverage(coverage, kit.coverage.passes);
  const checked = checkBuilderDocument({ kit, state });
  if (!checked.ok) return fail(checked.error);
  return {
    ok: true,
    document: { kit, state },
    warnings: checked.warnings,
    report: {
      ...report,
      gaps: {
        uncovered_must_ids: coverage.uncovered_must_ids,
        uncovered_ids: coverage.uncovered_requirement_ids,
      },
    },
  };
}

function applyBrief(
  kit: Kit,
  state: BuilderState,
  input: Extract<RegenerationApply, { section: 'brief' }>,
) {
  const report = emptyReport('brief', null);
  if (state.brief.pinned || state.brief.edited) {
    // A brief the user changed or pinned is theirs; regenerating must not overwrite it.
    report.kept.push('brief');
    report.skipped.push({
      reason: state.brief.pinned ? 'pinned' : 'edited',
      detail: `The company brief was ${state.brief.pinned ? 'pinned' : 'edited'}, so it was kept as it is.`,
    });
    return finish(kit, state, report);
  }
  kit.company_brief = { ...input.brief };
  report.replaced.push('brief');
  return finish(kit, state, report);
}

function applyQuestions(
  kit: Kit,
  state: BuilderState,
  input: Extract<RegenerationApply, { section: 'questions' }>,
): RegenerationResult {
  const { category } = input;
  const report = emptyReport('questions', category);
  const metaOf = (id: string) => state.questions.find((m) => m.id === id);
  const pinnedDays = new Set(state.days.filter((d) => d.pinned).map((d) => d.day));
  const pinnedDayOf = (id: string) =>
    kit.schedule.days.find((d) => pinnedDays.has(d.day) && d.question_ids.includes(id))?.day;

  const inCategory = kit.questions.filter((q) => q.category === category);
  const removable = new Set<string>();
  for (const q of inCategory) {
    const meta = metaOf(q.id);
    const day = pinnedDayOf(q.id);
    if (!meta || meta.origin === 'manual' || meta.edited || meta.pinned || day !== undefined) {
      report.kept.push(q.id);
      if (meta?.pinned)
        report.skipped.push({ reason: 'pinned', detail: `Question ${q.id} is pinned.` });
      else if (meta?.edited)
        report.skipped.push({ reason: 'edited', detail: `Question ${q.id} was edited.` });
      else if (day !== undefined) {
        report.skipped.push({
          reason: 'on_pinned_day',
          detail: `Question ${q.id} is on pinned day ${day}.`,
        });
      }
    } else {
      removable.add(q.id);
    }
  }

  const retained = kit.questions.filter((q) => !removable.has(q.id));
  const seen = new Set(retained.map((q) => normalizeForMatch(q.prompt)));
  const known = new Set(kit.role.requirements.map((r) => r.id));
  const tombstones = state.tombstones.filter((t) => t.kind === 'question');

  const accepted: Extract<RegenerationApply, { section: 'questions' }>['questions'] = [];
  for (const candidate of input.questions) {
    const label =
      candidate.prompt.length > 60 ? `${candidate.prompt.slice(0, 59)}…` : candidate.prompt;
    const refs = [...new Set(candidate.requirement_ids)];
    if (refs.some((id) => !known.has(id))) {
      report.skipped.push({
        reason: 'unknown_requirement',
        detail: `"${label}" names a requirement that does not exist.`,
      });
      continue;
    }
    const key = normalizeForMatch(candidate.prompt);
    if (tombstones.some((t) => tombstoneMatches(candidate.prompt, t))) {
      report.skipped.push({
        reason: 'tombstone',
        detail: `"${label}" was deleted earlier and is not brought back.`,
      });
      continue;
    }
    if (key !== '' && seen.has(key)) {
      report.skipped.push({
        reason: 'duplicate',
        detail: `"${label}" repeats a question that is already in the kit.`,
      });
      continue;
    }
    seen.add(key);
    accepted.push({ ...candidate, requirement_ids: refs });
  }

  // Remove what is being replaced, from the kit and from its days.
  const affected = new Set<number>();
  for (const day of kit.schedule.days) {
    const before = day.question_ids.length;
    day.question_ids = day.question_ids.filter((id) => !removable.has(id));
    if (day.question_ids.length !== before) affected.add(day.day);
  }
  kit.questions = retained;
  state.questions = state.questions.filter((m) => !removable.has(m.id));
  report.replaced.push(...removable);

  // New questions go to the unpinned day with the fewest questions (the earliest on a tie).
  const open = kit.schedule.days.filter((d) => !pinnedDays.has(d.day));
  for (const candidate of accepted) {
    const target = open.reduce<(typeof open)[number] | undefined>(
      (best, d) =>
        best === undefined || d.question_ids.length < best.question_ids.length ? d : best,
      undefined,
    );
    if (!target) {
      report.skipped.push({
        reason: 'no_schedulable_day',
        detail: `Every day is pinned, so "${candidate.prompt.slice(0, 40)}" could not be scheduled and was not added.`,
      });
      continue;
    }
    const n = state.next_ids.question;
    state.next_ids.question = n + 1;
    const id = `${ID_PREFIX.question}${n}`;
    const question: Question = {
      id,
      requirement_ids: candidate.requirement_ids,
      category,
      prompt: candidate.prompt,
      answer_outline: candidate.answer_outline,
      difficulty: candidate.difficulty,
    };
    kit.questions.push(question);
    state.questions.push({ id, origin: 'generated', edited: false, pinned: false });
    target.question_ids.push(id);
    affected.add(target.day);
    report.added.push(id);
  }

  refreshAutoDays(kit, state, affected);
  return finish(kit, state, report);
}

/**
 * Re-spreads the questions that are not on a pinned day across the days that are not pinned, with the
 * shared allocator. Pinned days are left exactly as they are, and so is a focus or a minutes value the
 * user set on any day. The number of days never changes.
 */
function applySchedule(kit: Kit, state: BuilderState): RegenerationResult {
  const report = emptyReport('schedule', null);
  const pinned = new Set(state.days.filter((d) => d.pinned).map((d) => d.day));
  const pinnedIds = new Set(
    kit.schedule.days.filter((d) => pinned.has(d.day)).flatMap((d) => d.question_ids),
  );
  const open = kit.schedule.days.filter((d) => !pinned.has(d.day));
  report.days = { kept: [...pinned].sort((a, b) => a - b), reallocated: open.map((d) => d.day) };
  report.kept.push(...report.days.kept.map((d) => `day ${d}`));

  if (open.length === 0) {
    report.skipped.push({
      reason: 'pinned',
      detail: 'Every day is pinned, so the schedule was kept as it is.',
    });
    return finish(kit, state, report);
  }

  const pool = kit.questions.filter((q) => !pinnedIds.has(q.id));
  const allocation = allocateSchedule({
    days: open.length,
    questions: pool,
    requirements: kit.role.requirements,
  });
  open.forEach((day, i) => {
    const planned = allocation.days[i];
    if (!planned) return;
    const meta = state.days.find((d) => d.day === day.day);
    day.question_ids = planned.question_ids;
    if (!meta?.focus_manual) day.focus = planned.focus;
    if (!meta?.minutes_manual) day.minutes = planned.minutes;
  });
  return finish(kit, state, report);
}

/**
 * Applies regenerated material to a document. On success the returned document is new (the input is
 * untouched) and the report says what was kept, replaced, added and skipped, and which gaps remain.
 */
export function applyRegeneration(doc: BuilderDocument, input: unknown): RegenerationResult {
  const before = checkBuilderDocument(doc);
  if (!before.ok) return fail(before.error);

  const parsed = regenerationApplySchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail({
      code: 'INVALID_OPERATION',
      message: issue?.message ?? 'Invalid regeneration',
      path: (issue?.path ?? []).join('.'),
    });
  }

  const kit = clone(doc.kit);
  const state = clone(doc.state);
  switch (parsed.data.section) {
    case 'brief':
      return applyBrief(kit, state, parsed.data);
    case 'questions':
      return applyQuestions(kit, state, parsed.data);
    case 'schedule':
      return applySchedule(kit, state);
  }
}
