import { describe, expect, it } from 'vitest';
import { batchOutputSchema, kitSchema } from './index.js';

const validKit = {
  source: {
    company: 'Acme',
    company_url: 'http://localhost:8099/acme/',
    role: 'Senior Backend Engineer',
    location: 'Remote',
    jd_chars: 120,
    researched_at: '2026-09-01T09:12:44Z',
    pages_used: ['http://localhost:8099/acme/'],
  },
  company_brief: { summary: 's', what_they_do: 'w', sources: [] },
  role: {
    title: 'Senior Backend Engineer',
    seniority: 'senior',
    responsibilities: ['Build APIs'],
    requirements: [{ id: 'r1', text: '5+ years with Node', kind: 'technical', priority: 'must' }],
  },
  questions: [
    {
      id: 'q1',
      requirement_ids: ['r1'],
      category: 'technical',
      prompt: 'Explain the event loop.',
      answer_outline: 'Phases, microtasks.',
      difficulty: 2,
    },
  ],
  flashcards: [{ id: 'f1', front: 'f', back: 'b', requirement_ids: ['r1'] }],
  schedule: {
    days_available: 1,
    days: [{ day: 1, focus: 'Node', question_ids: ['q1'], minutes: 60 }],
  },
  coverage: { uncovered_requirement_ids: [], passes: 1 },
};

describe('kitSchema (Appendix A structure)', () => {
  it('accepts a valid kit', () => {
    expect(kitSchema.safeParse(validKit).success).toBe(true);
  });

  it('rejects a missing top-level field', () => {
    const rest: Record<string, unknown> = { ...validKit };
    delete rest.coverage;
    expect(kitSchema.safeParse(rest).success).toBe(false);
  });

  it.each([0, 4, 1.5])('rejects difficulty %s', (difficulty) => {
    const kit = { ...validKit, questions: [{ ...validKit.questions[0], difficulty }] };
    expect(kitSchema.safeParse(kit).success).toBe(false);
  });

  it('rejects non-integer schedule minutes', () => {
    const kit = {
      ...validKit,
      schedule: { days_available: 1, days: [{ ...validKit.schedule.days[0], minutes: 59.5 }] },
    };
    expect(kitSchema.safeParse(kit).success).toBe(false);
  });

  it('rejects unknown category and priority values', () => {
    const badCategory = { ...validKit, questions: [{ ...validKit.questions[0], category: 'x' }] };
    expect(kitSchema.safeParse(badCategory).success).toBe(false);
    const badPriority = {
      ...validKit,
      role: {
        ...validKit.role,
        requirements: [{ ...validKit.role.requirements[0], priority: 'p' }],
      },
    };
    expect(kitSchema.safeParse(badPriority).success).toBe(false);
  });
});

describe('batchOutputSchema (Appendix B)', () => {
  it('accepts ok and failed entries', () => {
    const out = {
      version: '1.0',
      generated_at: '2026-09-01T09:12:44Z',
      kits: [
        { id: 'case-01', status: 'ok', kit: validKit, error: null },
        {
          id: 'case-04',
          status: 'failed',
          kit: null,
          error: { code: 'COMPANY_UNREACHABLE', message: 'unreachable' },
        },
      ],
    };
    expect(batchOutputSchema.safeParse(out).success).toBe(true);
  });

  it('rejects a failed entry that carries a kit', () => {
    const out = {
      version: '1.0',
      generated_at: 'x',
      kits: [{ id: 'a', status: 'failed', kit: validKit, error: { code: 'X', message: 'm' } }],
    };
    expect(batchOutputSchema.safeParse(out).success).toBe(false);
  });
});
