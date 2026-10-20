import { kitSchema, type Kit } from '@trao/contracts';
import { checkCoverage } from './coverage';

/**
 * Full kit validation: Appendix A structure (via the shared Zod schema) followed by the
 * cross-reference and schedule invariants Zod cannot express. Issues are produced in a fixed
 * order, so the same kit always yields the same list.
 *
 * `error` issues make the kit invalid. `warning` issues are legitimate states the builder can
 * produce (for example a hand-added question that has not been scheduled yet).
 */

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: IssueSeverity;
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** Present only when the structure is valid. */
  kit?: Kit;
}

export interface ValidateOptions {
  /** The number of days the user asked for; the schedule must match it. */
  requestedDays?: number | undefined;
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  return path.reduce<string>((out, part) => {
    if (typeof part === 'number') return `${out}[${part}]`;
    const key = String(part);
    return out === '' ? key : `${out}.${key}`;
  }, '');
}

function findDuplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) (seen.has(id) ? dupes : seen).add(id);
  return [...dupes];
}

export function validateKit(input: unknown, options: ValidateOptions = {}): ValidationResult {
  const parsed = kitSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map<ValidationIssue>((i) => ({
      severity: 'error',
      code: 'SCHEMA_INVALID',
      path: formatPath(i.path),
      message: i.message,
    }));
    return { ok: false, issues };
  }

  const kit = parsed.data;
  const issues: ValidationIssue[] = [];
  const error = (code: string, path: string, message: string) =>
    issues.push({ severity: 'error', code, path, message });
  const warning = (code: string, path: string, message: string) =>
    issues.push({ severity: 'warning', code, path, message });

  const requirements = kit.role.requirements;
  const requirementIds = new Set(requirements.map((r) => r.id));
  const questionIds = new Set(kit.questions.map((q) => q.id));

  // Unique ids, per collection (each collection is its own namespace).
  for (const id of findDuplicates(requirements.map((r) => r.id))) {
    error(
      'DUPLICATE_REQUIREMENT_ID',
      'role.requirements',
      `Requirement id "${id}" is used more than once`,
    );
  }
  for (const id of findDuplicates(kit.questions.map((q) => q.id))) {
    error('DUPLICATE_QUESTION_ID', 'questions', `Question id "${id}" is used more than once`);
  }
  for (const id of findDuplicates(kit.flashcards.map((f) => f.id))) {
    error('DUPLICATE_FLASHCARD_ID', 'flashcards', `Flashcard id "${id}" is used more than once`);
  }

  // Requirement references.
  kit.questions.forEach((q, qi) =>
    q.requirement_ids.forEach((id, ri) => {
      if (!requirementIds.has(id)) {
        error(
          'UNKNOWN_REQUIREMENT_REFERENCE',
          `questions[${qi}].requirement_ids[${ri}]`,
          `Question "${q.id}" references unknown requirement "${id}"`,
        );
      }
    }),
  );
  kit.flashcards.forEach((f, fi) =>
    f.requirement_ids.forEach((id, ri) => {
      if (!requirementIds.has(id)) {
        error(
          'UNKNOWN_REQUIREMENT_REFERENCE',
          `flashcards[${fi}].requirement_ids[${ri}]`,
          `Flashcard "${f.id}" references unknown requirement "${id}"`,
        );
      }
    }),
  );

  // Schedule shape.
  const { schedule } = kit;
  if (schedule.days.length !== schedule.days_available) {
    error(
      'SCHEDULE_DAY_COUNT_MISMATCH',
      'schedule.days',
      `days_available is ${schedule.days_available} but ${schedule.days.length} day entries exist`,
    );
  }
  if (options.requestedDays !== undefined && schedule.days_available !== options.requestedDays) {
    error(
      'DAYS_REQUESTED_MISMATCH',
      'schedule.days_available',
      `${options.requestedDays} days were requested but the schedule spans ${schedule.days_available}`,
    );
  }
  schedule.days.forEach((d, i) => {
    if (d.day !== i + 1) {
      error(
        'SCHEDULE_DAY_NUMBERING',
        `schedule.days[${i}].day`,
        `Expected day ${i + 1}, found ${d.day}`,
      );
    }
  });

  // Schedule references.
  const scheduled = new Set<string>();
  const scheduledTwice = new Set<string>();
  schedule.days.forEach((d, di) =>
    d.question_ids.forEach((id, qi) => {
      if (!questionIds.has(id)) {
        error(
          'UNKNOWN_QUESTION_REFERENCE',
          `schedule.days[${di}].question_ids[${qi}]`,
          `Day ${d.day} schedules unknown question "${id}"`,
        );
        return;
      }
      if (scheduled.has(id)) scheduledTwice.add(id);
      scheduled.add(id);
    }),
  );
  for (const id of scheduledTwice) {
    error(
      'DUPLICATE_SCHEDULED_QUESTION',
      'schedule.days',
      `Question "${id}" is scheduled more than once`,
    );
  }
  kit.questions.forEach((q, qi) => {
    if (!scheduled.has(q.id)) {
      warning(
        'UNSCHEDULED_QUESTION',
        `questions[${qi}]`,
        `Question "${q.id}" is not in the schedule`,
      );
    }
  });

  // Coverage-derived rules.
  const report = checkCoverage(requirements, kit.questions);

  const mustIds = new Set(requirements.filter((r) => r.priority === 'must').map((r) => r.id));
  for (const id of report.covered_requirement_ids) {
    if (!mustIds.has(id)) continue;
    const representedInSchedule = kit.questions.some(
      (q) => q.requirement_ids.includes(id) && scheduled.has(q.id),
    );
    if (!representedInSchedule) {
      error(
        'MUST_NOT_SCHEDULED',
        'schedule.days',
        `Must-have requirement "${id}" is not in any scheduled question`,
      );
    }
  }

  const declared = [...kit.coverage.uncovered_requirement_ids].sort();
  const computed = [...report.uncovered_requirement_ids].sort();
  if (declared.length !== computed.length || declared.some((id, i) => id !== computed[i])) {
    error(
      'COVERAGE_MISMATCH',
      'coverage.uncovered_requirement_ids',
      `Declared [${declared.join(', ')}] but the questions leave [${computed.join(', ')}] uncovered`,
    );
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues, kit };
}
