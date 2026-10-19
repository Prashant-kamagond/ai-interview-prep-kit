import { describe, expect, it } from 'vitest';
import { makeKit } from './fixtures.js';
import { validateKit } from './validate.js';

function codes(input: unknown, requestedDays?: number) {
  return validateKit(input, { requestedDays }).issues.map((i) => i.code);
}

describe('validateKit', () => {
  it('accepts a consistent kit and returns it unchanged', () => {
    const kit = makeKit();
    const r = validateKit(kit, { requestedDays: 2 });
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.kit).toEqual(kit);
    expect(Object.keys(r.kit ?? {})).toEqual([
      'source',
      'company_brief',
      'role',
      'questions',
      'flashcards',
      'schedule',
      'coverage',
    ]);
  });

  it('reports structural problems with a path and skips reference checks', () => {
    const kit = makeKit();
    const bad = { ...kit, questions: [{ ...kit.questions[0], difficulty: 4 }] };
    const r = validateKit(bad);
    expect(r.ok).toBe(false);
    expect(r.kit).toBeUndefined();
    expect(r.issues.map((i) => i.code)).toEqual(['SCHEMA_INVALID']);
    expect(r.issues[0]?.path).toBe('questions[0].difficulty');
  });

  it('rejects non-integer minutes and a non-object input', () => {
    const kit = makeKit();
    kit.schedule.days[0]!.minutes = 12.5;
    expect(validateKit(kit).issues[0]?.path).toBe('schedule.days[0].minutes');
    expect(codes(null)).toEqual(['SCHEMA_INVALID']);
  });

  it('flags duplicate ids within each collection independently', () => {
    const kit = makeKit();
    kit.role.requirements.push({ ...kit.role.requirements[0]! });
    kit.questions.push({ ...kit.questions[0]! });
    kit.flashcards.push({ ...kit.flashcards[0]! });
    const c = codes(kit);
    expect(c).toContain('DUPLICATE_REQUIREMENT_ID');
    expect(c).toContain('DUPLICATE_QUESTION_ID');
    expect(c).toContain('DUPLICATE_FLASHCARD_ID');
  });

  it('allows the same id string in different collections', () => {
    const kit = makeKit();
    kit.flashcards[0]!.id = 'q1';
    expect(validateKit(kit).ok).toBe(true);
  });

  it('flags unknown requirement references on questions and flashcards', () => {
    const kit = makeKit();
    kit.questions[0]!.requirement_ids = ['r1', 'r99'];
    kit.flashcards[0]!.requirement_ids = ['r98'];
    const issues = validateKit(kit).issues.filter(
      (i) => i.code === 'UNKNOWN_REQUIREMENT_REFERENCE',
    );
    expect(issues.map((i) => i.path)).toEqual([
      'questions[0].requirement_ids[1]',
      'flashcards[0].requirement_ids[0]',
    ]);
  });

  it('flags a scheduled question id that does not exist', () => {
    const kit = makeKit();
    kit.schedule.days[1]!.question_ids = ['q404'];
    const issue = validateKit(kit).issues.find((i) => i.code === 'UNKNOWN_QUESTION_REFERENCE');
    expect(issue?.path).toBe('schedule.days[1].question_ids[0]');
  });

  it('flags a wrong number of day entries and wrong day numbering', () => {
    const kit = makeKit();
    kit.schedule.days_available = 3;
    expect(codes(kit)).toContain('SCHEDULE_DAY_COUNT_MISMATCH');

    const kit2 = makeKit();
    kit2.schedule.days[1]!.day = 5;
    expect(codes(kit2)).toContain('SCHEDULE_DAY_NUMBERING');
  });

  it('flags a schedule that does not match the requested number of days', () => {
    expect(codes(makeKit(), 5)).toContain('DAYS_REQUESTED_MISMATCH');
    expect(codes(makeKit(), 2)).not.toContain('DAYS_REQUESTED_MISMATCH');
  });

  it('flags a question scheduled twice as an error', () => {
    const kit = makeKit();
    kit.schedule.days[1]!.question_ids = ['q1', 'q2'];
    expect(codes(kit)).toContain('DUPLICATE_SCHEDULED_QUESTION');
  });

  it('treats an unscheduled question as a warning, not a failure', () => {
    const kit = makeKit();
    kit.schedule.days[1]!.question_ids = [];
    const r = validateKit(kit);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([
      expect.objectContaining({ code: 'UNSCHEDULED_QUESTION', severity: 'warning' }),
    ]);
  });

  it('flags a covered must-have that is missing from the schedule', () => {
    const kit = makeKit();
    kit.schedule.days[0]!.question_ids = [];
    kit.schedule.days[1]!.question_ids = ['q2'];
    expect(validateKit(kit).issues).toContainEqual(
      expect.objectContaining({ code: 'MUST_NOT_SCHEDULED', severity: 'error' }),
    );
  });

  it('does not demand scheduling for a must-have that has no question (that is a coverage gap)', () => {
    const kit = makeKit();
    kit.questions = [kit.questions[1]!];
    kit.schedule.days[0]!.question_ids = [];
    kit.coverage.uncovered_requirement_ids = ['r1'];
    expect(codes(kit)).not.toContain('MUST_NOT_SCHEDULED');
  });

  it('flags a coverage section that disagrees with the questions', () => {
    const kit = makeKit();
    kit.coverage.uncovered_requirement_ids = ['r2'];
    expect(codes(kit)).toContain('COVERAGE_MISMATCH');

    const kit2 = makeKit();
    kit2.coverage.uncovered_requirement_ids = ['r77'];
    expect(codes(kit2)).toContain('COVERAGE_MISMATCH');
  });

  it('returns issues in a deterministic order', () => {
    const kit = makeKit();
    kit.questions[0]!.requirement_ids = ['rX'];
    kit.schedule.days[1]!.question_ids = ['qZ'];
    const a = validateKit(kit).issues;
    expect(validateKit(structuredClone(kit)).issues).toEqual(a);
  });
});
