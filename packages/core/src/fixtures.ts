import type { Kit, Question, Requirement } from '@trao/contracts';

/** Test helpers shared by the core test suites. Not exported from the package. */

export function req(
  id: string,
  priority: 'must' | 'nice' = 'must',
  text = `Requirement ${id}`,
): Requirement {
  return { id, text, kind: 'technical', priority };
}

export function question(
  id: string,
  requirementIds: string[],
  overrides: Partial<Question> = {},
): Question {
  return {
    id,
    requirement_ids: requirementIds,
    category: 'technical',
    prompt: `Prompt ${id}`,
    answer_outline: `Outline ${id}`,
    difficulty: 2,
    ...overrides,
  };
}

/** A small, fully consistent kit: 2 requirements, 2 questions, 1 flashcard, 2 days. */
export function makeKit(): Kit {
  return {
    source: {
      company: 'Acme',
      company_url: 'http://localhost:8099/acme/',
      role: 'Backend Engineer',
      location: 'Remote',
      jd_chars: 200,
      researched_at: '2026-09-01T09:12:44Z',
      pages_used: ['http://localhost:8099/acme/'],
    },
    company_brief: { summary: 's', what_they_do: 'w', sources: [] },
    role: {
      title: 'Backend Engineer',
      seniority: 'senior',
      responsibilities: ['Build APIs'],
      requirements: [req('r1', 'must', '5+ years Node'), req('r2', 'nice', 'Kafka experience')],
    },
    questions: [
      question('q1', ['r1'], { difficulty: 3 }),
      question('q2', ['r2'], { difficulty: 1 }),
    ],
    flashcards: [{ id: 'f1', front: 'f', back: 'b', requirement_ids: ['r1'] }],
    schedule: {
      days_available: 2,
      days: [
        { day: 1, focus: 'Node', question_ids: ['q1'], minutes: 20 },
        { day: 2, focus: 'Kafka', question_ids: ['q2'], minutes: 10 },
      ],
    },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
  };
}
