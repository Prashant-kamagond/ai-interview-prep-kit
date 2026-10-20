import { kitSchema, type Kit } from '@trao/contracts';
import type { KitRecord } from '../lib/api/kits';

/** A complete Appendix A kit, checked by the real kitSchema so the fixture cannot drift from it. */
export function makeKit(over: Partial<Kit> = {}): Kit {
  return kitSchema.parse({
    source: {
      company: 'Acme Corp',
      company_url: 'https://acme.example',
      role: 'Senior Backend Engineer',
      location: 'Remote (EU)',
      jd_chars: 1200,
      researched_at: '2026-03-01T10:00:00.000Z',
      pages_used: ['https://acme.example/careers', 'not a url'],
    },
    company_brief: {
      summary: 'Acme builds payment tools for small shops.',
      what_they_do: 'Card readers and a dashboard.',
      sources: ['https://acme.example/careers', 'javascript:alert(1)'],
    },
    role: {
      title: 'Senior Backend Engineer',
      seniority: 'Senior',
      responsibilities: ['Design services', 'Mentor engineers'],
      requirements: [
        { id: 'r1', text: 'Build REST APIs in Node.js', kind: 'technical', priority: 'must' },
        { id: 'r2', text: 'Communicate with stakeholders', kind: 'behavioural', priority: 'must' },
        { id: 'r3', text: 'Experience with payments', kind: 'domain', priority: 'nice' },
        { id: 'r4', text: 'Operate Kubernetes in production', kind: 'technical', priority: 'must' },
      ],
    },
    questions: [
      {
        id: 'q1',
        requirement_ids: ['r1'],
        category: 'technical',
        prompt: 'How do you version a REST API?',
        answer_outline: 'URL vs header versioning.\nDeprecation policy.',
        difficulty: 2,
      },
      {
        id: 'q2',
        requirement_ids: ['r2'],
        category: 'behavioural',
        prompt: 'Tell me about a disagreement with a stakeholder.',
        answer_outline: 'STAR format.',
        difficulty: 1,
      },
      {
        id: 'q3',
        requirement_ids: ['r1', 'r3'],
        category: 'system-design',
        prompt: 'Design a payment webhook system.',
        answer_outline: 'Retries, idempotency.',
        difficulty: 3,
      },
      {
        id: 'q4',
        requirement_ids: [],
        category: 'company-fit',
        prompt: 'Why Acme?',
        answer_outline: '',
        difficulty: 1,
      },
    ],
    flashcards: [
      {
        id: 'f1',
        front: 'What is idempotency?',
        back: 'Same request, same effect.',
        requirement_ids: ['r1'],
      },
    ],
    schedule: {
      days_available: 3,
      days: [
        { day: 2, focus: 'Systems and people', question_ids: ['q3', 'q2'], minutes: 90 },
        { day: 1, focus: 'APIs', question_ids: ['q1', 'q4'], minutes: 60 },
        { day: 3, focus: 'Review', question_ids: [], minutes: 30 },
      ],
    },
    coverage: { uncovered_requirement_ids: ['r4'], passes: 2 },
    ...over,
  });
}

/** A kit with every list and text empty: valid under the contract, nothing to show. */
export function makeEmptyKit(): Kit {
  return kitSchema.parse({
    source: {
      company: '',
      company_url: '',
      role: '',
      location: '',
      jd_chars: 0,
      researched_at: '',
      pages_used: [],
    },
    company_brief: { summary: '', what_they_do: '', sources: [] },
    role: { title: '', seniority: '', responsibilities: [], requirements: [] },
    questions: [],
    flashcards: [],
    schedule: { days_available: 1, days: [] },
    coverage: { uncovered_requirement_ids: [], passes: 0 },
  });
}

export function makeRecord(kit: Kit = makeKit(), over: Partial<KitRecord> = {}): KitRecord {
  return {
    id: 'a'.repeat(24),
    version: 1,
    kit,
    created_at: '2026-03-01T10:00:00.000Z',
    updated_at: '2026-03-01T10:00:00.000Z',
    ...over,
  };
}
