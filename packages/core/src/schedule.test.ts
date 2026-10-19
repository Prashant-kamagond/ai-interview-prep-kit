import { describe, expect, it } from 'vitest';
import type { Question, Requirement } from '@trao/contracts';
import { question, req } from './fixtures.js';
import { allocateSchedule, MINUTES_BY_DIFFICULTY, REVIEW_DAY_MINUTES } from './schedule.js';

function assertInvariants(
  schedule: ReturnType<typeof allocateSchedule>,
  days: number,
  questions: Question[],
  requirements: Requirement[],
) {
  expect(schedule.days_available).toBe(days);
  expect(schedule.days).toHaveLength(days);
  const ids = new Set(questions.map((q) => q.id));
  const seen: string[] = [];
  schedule.days.forEach((d, i) => {
    expect(d.day).toBe(i + 1);
    expect(d.focus.trim().length).toBeGreaterThan(0);
    expect(Number.isInteger(d.minutes)).toBe(true);
    expect(d.minutes).toBeGreaterThan(0);
    for (const id of d.question_ids) {
      expect(ids.has(id)).toBe(true);
      seen.push(id);
    }
  });
  // every question is allocated exactly once
  expect([...seen].sort()).toEqual([...ids].sort());
  // every must-have that has a question is represented
  const scheduled = new Set(seen);
  for (const r of requirements.filter((x) => x.priority === 'must')) {
    const has = questions.filter((q) => q.requirement_ids.includes(r.id));
    if (has.length > 0) expect(has.some((q) => scheduled.has(q.id))).toBe(true);
  }
}

function sample(n: number): { questions: Question[]; requirements: Requirement[] } {
  const requirements = Array.from({ length: n }, (_, i) =>
    req(`r${i + 1}`, i % 3 === 2 ? 'nice' : 'must'),
  );
  const questions = requirements.map((r, i) =>
    question(`q${i + 1}`, [r.id], { difficulty: ((i % 3) + 1) as 1 | 2 | 3 }),
  );
  return { questions, requirements };
}

describe('allocateSchedule invariants', () => {
  const dayCounts = [1, 2, 3, 5, 7, 14, 30, 60];
  const questionCounts = [0, 1, 2, 5, 12, 40];

  for (const days of dayCounts) {
    for (const n of questionCounts) {
      it(`holds for ${days} day(s) and ${n} question(s)`, () => {
        const { questions, requirements } = sample(n);
        const schedule = allocateSchedule({ days, questions, requirements });
        assertInvariants(schedule, days, questions, requirements);
      });
    }
  }
});

describe('allocateSchedule behaviour', () => {
  it('puts everything on day 1 for a one-day schedule', () => {
    const { questions, requirements } = sample(6);
    const s = allocateSchedule({ days: 1, questions, requirements });
    expect(s.days[0]?.question_ids).toHaveLength(6);
  });

  it('gives each question its own day and leaves the rest as review days when days > questions', () => {
    const { questions, requirements } = sample(5);
    const s = allocateSchedule({ days: 60, questions, requirements });
    expect(s.days.slice(0, 5).every((d) => d.question_ids.length === 1)).toBe(true);
    const review = s.days.slice(5);
    expect(review).toHaveLength(55);
    for (const d of review) {
      expect(d.question_ids).toEqual([]);
      expect(d.minutes).toBe(REVIEW_DAY_MINUTES);
    }
  });

  it('spreads questions so day sizes differ by at most one, earlier days never smaller', () => {
    const { questions, requirements } = sample(11);
    const sizes = allocateSchedule({ days: 4, questions, requirements }).days.map(
      (d) => d.question_ids.length,
    );
    expect(sizes).toEqual([3, 3, 3, 2]);
  });

  it('schedules must-have material before nice-to-have material', () => {
    const requirements = [req('r1', 'nice'), req('r2', 'must')];
    const questions = [question('q1', ['r1'], { difficulty: 3 }), question('q2', ['r2'])];
    const s = allocateSchedule({ days: 2, questions, requirements });
    expect(s.days[0]?.question_ids).toEqual(['q2']);
    expect(s.days[1]?.question_ids).toEqual(['q1']);
  });

  it('schedules harder questions earlier within the same priority', () => {
    const requirements = [req('r1'), req('r2'), req('r3')];
    const questions = [
      question('q1', ['r1'], { difficulty: 1 }),
      question('q2', ['r2'], { difficulty: 3 }),
      question('q3', ['r3'], { difficulty: 2 }),
    ];
    const s = allocateSchedule({ days: 3, questions, requirements });
    expect(s.days.map((d) => d.question_ids[0])).toEqual(['q2', 'q3', 'q1']);
  });

  it('breaks ties by original question order', () => {
    const requirements = [req('r1'), req('r2')];
    const questions = [question('qa', ['r1']), question('qb', ['r2'])];
    const s = allocateSchedule({ days: 2, questions, requirements });
    expect(s.days.map((d) => d.question_ids[0])).toEqual(['qa', 'qb']);
  });

  it('sums per-difficulty minutes for a day and uses the review length for empty days', () => {
    expect(MINUTES_BY_DIFFICULTY).toEqual({ 1: 10, 2: 15, 3: 20 });
    const requirements = [req('r1')];
    const questions = [
      question('q1', ['r1'], { difficulty: 3 }),
      question('q2', ['r1'], { difficulty: 1 }),
    ];
    const s = allocateSchedule({ days: 3, questions, requirements });
    expect(s.days.map((d) => d.minutes)).toEqual([20, 10, REVIEW_DAY_MINUTES]);
    const one = allocateSchedule({ days: 1, questions, requirements });
    expect(one.days[0]?.minutes).toBe(30);
  });

  it('produces review days only when there are no questions', () => {
    const s = allocateSchedule({ days: 3, questions: [], requirements: [req('r1')] });
    expect(s.days).toHaveLength(3);
    expect(s.days.every((d) => d.question_ids.length === 0)).toBe(true);
    expect(s.days.every((d) => d.focus.length > 0)).toBe(true);
  });

  it('derives a day focus from its leading must-have requirement', () => {
    const requirements = [req('r1', 'must', '5+ years React')];
    const questions = [question('q1', ['r1'])];
    const s = allocateSchedule({ days: 1, questions, requirements });
    expect(s.days[0]?.focus).toContain('5+ years React');
  });

  it('still schedules questions that reference unknown requirements, without inventing ids', () => {
    const questions = [question('q1', ['r404']), question('q2', [], { category: 'company-fit' })];
    const s = allocateSchedule({ days: 2, questions, requirements: [] });
    expect(s.days.flatMap((d) => d.question_ids).sort()).toEqual(['q1', 'q2']);
  });

  it('is deterministic and does not mutate its input', () => {
    const { questions, requirements } = sample(9);
    const frozenQ = Object.freeze(questions.map((q) => Object.freeze(q)));
    const frozenR = Object.freeze(requirements.map((r) => Object.freeze(r)));
    const a = allocateSchedule({ days: 4, questions: frozenQ, requirements: frozenR });
    const b = allocateSchedule({ days: 4, questions: frozenQ, requirements: frozenR });
    expect(a).toEqual(b);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects days = %s', (days) => {
    expect(() => allocateSchedule({ days, questions: [], requirements: [] })).toThrow(RangeError);
  });

  it('rejects duplicate question ids rather than scheduling an id twice', () => {
    const questions = [question('q1', []), question('q1', [])];
    expect(() => allocateSchedule({ days: 2, questions, requirements: [] })).toThrow(/duplicate/i);
  });
});
