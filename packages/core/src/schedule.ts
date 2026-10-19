import type { Question, QuestionCategory, Requirement, Schedule } from '@trao/contracts';

/**
 * Deterministic study-schedule allocation (assignment §8). Pure arithmetic: no model involved.
 *
 * Policy
 * ------
 * 1. Rank questions: any must-have requirement first, then higher difficulty, then more must-have
 *    requirements covered, then original order (so ties are stable and the output is repeatable).
 * 2. Split the ranked list into `days` contiguous chunks whose sizes differ by at most one, with
 *    the larger chunks on the earliest days. Hard and high-priority material therefore lands early.
 * 3. Every question is scheduled exactly once, so every must-have that has a question is scheduled.
 *    A must-have with no question at all is a coverage gap, reported by `checkCoverage`, not hidden
 *    here.
 * 4. Minutes are integers: the sum of per-question estimates (10/15/20 by difficulty). When there
 *    are fewer questions than days, the surplus days legitimately hold no questions; they are
 *    30-minute review days. The same applies to every day when no questions exist.
 */

export const MINUTES_BY_DIFFICULTY = { 1: 10, 2: 15, 3: 20 } as const;
export const REVIEW_DAY_MINUTES = 30;
export const REVIEW_DAY_FOCUS = 'Review and mock practice';

const FALLBACK_QUESTION_MINUTES = MINUTES_BY_DIFFICULTY[2];
const MAX_FOCUS_TEXT = 80;

const CATEGORY_LABEL: Record<QuestionCategory, string> = {
  technical: 'Technical',
  behavioural: 'Behavioural',
  'system-design': 'System design',
  'company-fit': 'Company fit',
};

export interface AllocateScheduleInput {
  /** Number of days requested. Must be a positive integer. */
  days: number;
  questions: readonly Question[];
  requirements: readonly Requirement[];
}

interface RankedQuestion {
  question: Question;
  index: number;
  hasMust: boolean;
  mustCount: number;
}

function minutesFor(question: Question): number {
  const table: Record<number, number> = MINUTES_BY_DIFFICULTY;
  return table[question.difficulty] ?? FALLBACK_QUESTION_MINUTES;
}

function truncate(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= MAX_FOCUS_TEXT ? t : `${t.slice(0, MAX_FOCUS_TEXT - 1).trimEnd()}…`;
}

function dayFocus(items: RankedQuestion[], byId: Map<string, Requirement>): string {
  const lead = items[0];
  if (!lead) return REVIEW_DAY_FOCUS;

  const label = CATEGORY_LABEL[lead.question.category];
  const resolved = lead.question.requirement_ids
    .map((id) => byId.get(id))
    .filter((r): r is Requirement => r !== undefined);
  const topic = resolved.find((r) => r.priority === 'must') ?? resolved[0];

  const base = topic ? `${label}: ${truncate(topic.text)}` : `${label} questions`;
  return items.length > 1 ? `${base} (+${items.length - 1} more)` : base;
}

export function allocateSchedule(input: AllocateScheduleInput): Schedule {
  const { days, questions, requirements } = input;
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError(`days must be a positive integer, received ${String(days)}`);
  }

  const seenIds = new Set<string>();
  for (const q of questions) {
    if (seenIds.has(q.id)) throw new Error(`Duplicate question id: ${q.id}`);
    seenIds.add(q.id);
  }

  const byId = new Map<string, Requirement>();
  for (const r of requirements) if (!byId.has(r.id)) byId.set(r.id, r);

  const ranked: RankedQuestion[] = questions.map((question, index) => {
    const mustCount = new Set(
      question.requirement_ids.filter((id) => byId.get(id)?.priority === 'must'),
    ).size;
    return { question, index, hasMust: mustCount > 0, mustCount };
  });

  ranked.sort(
    (a, b) =>
      Number(b.hasMust) - Number(a.hasMust) ||
      b.question.difficulty - a.question.difficulty ||
      b.mustCount - a.mustCount ||
      a.index - b.index,
  );

  const base = Math.floor(ranked.length / days);
  const extra = ranked.length % days;
  let cursor = 0;

  const scheduleDays = Array.from({ length: days }, (_, i) => {
    const size = base + (i < extra ? 1 : 0);
    const items = ranked.slice(cursor, cursor + size);
    cursor += size;

    const minutes =
      items.length === 0
        ? REVIEW_DAY_MINUTES
        : items.reduce((sum, item) => sum + minutesFor(item.question), 0);

    return {
      day: i + 1,
      focus: dayFocus(items, byId),
      question_ids: items.map((item) => item.question.id),
      minutes,
    };
  });

  return { days_available: days, days: scheduleDays };
}
