import { describe, expect, it } from 'vitest';
import type { RegenerationReport, Requirement, ResearchSnapshot } from '@trao/contracts';
import {
  categoryHasRequirements,
  describeSkip,
  sectionName,
  sourceNote,
  summarizeReport,
} from './regeneration';

const UNAVAILABLE: ResearchSnapshot = { status: 'unavailable', reason: 'not_persisted' };
const STORED: ResearchSnapshot = {
  status: 'available',
  captured_at: 't',
  company_url: 'https://a.test/',
  company_name: 'A',
  crawl_status: 'ok',
  pages: [],
  discussion: { provider: 'hn', status: 'no_results', retrieved_at: 't', items: [] },
};
const req = (id: string, kind: Requirement['kind']): Requirement => ({
  id,
  text: id,
  kind,
  priority: 'must',
});
const BOTH = [req('r1', 'technical'), req('r2', 'behavioural')];

describe('sectionName', () => {
  it('names each section in words', () => {
    expect(sectionName({ section: 'brief' })).toBe('the company brief');
    expect(sectionName({ section: 'schedule' })).toBe('the schedule');
    expect(sectionName({ section: 'questions', category: 'system-design' })).toBe(
      'the system design questions',
    );
    expect(sectionName({ section: 'questions', category: 'company-fit' })).toBe(
      'the company fit questions',
    );
  });
});

describe('sourceNote: what each regeneration needs, shown before submitting', () => {
  it('the schedule needs only the kit', () => {
    expect(sourceNote({ section: 'schedule' }, UNAVAILABLE, [])).toMatchObject({
      available: true,
      needs: expect.stringMatching(/only the current kit/),
    });
  });

  it('the brief and company-fit questions need stored research, and say why when there is none', () => {
    for (const request of [
      { section: 'brief' as const },
      { section: 'questions' as const, category: 'company-fit' as const },
    ]) {
      const none = sourceNote(request, UNAVAILABLE, BOTH);
      expect(none.available).toBe(false);
      expect(none.reason).toMatch(/not kept/);
      expect(none.reason).toMatch(/never reconstructed/);
      expect(sourceNote(request, STORED, BOTH)).toMatchObject({ available: true });
      expect(sourceNote(request, STORED, BOTH).reason).toBeUndefined();
    }
  });

  it('other categories need requirements of their kind, not research', () => {
    expect(
      sourceNote({ section: 'questions', category: 'technical' }, UNAVAILABLE, BOTH).available,
    ).toBe(true);
    expect(
      sourceNote({ section: 'questions', category: 'technical' }, UNAVAILABLE, BOTH).needs,
    ).toMatch(/not required/);
    const onlyTechnical = [req('r1', 'technical')];
    const behavioural = sourceNote(
      { section: 'questions', category: 'behavioural' },
      STORED,
      onlyTechnical,
    );
    expect(behavioural.available).toBe(false);
    expect(behavioural.reason).toMatch(/no behavioural requirements/);
  });

  it('knows which requirement kinds each category can ask about', () => {
    expect(categoryHasRequirements('technical', [req('a', 'domain')])).toBe(true);
    expect(categoryHasRequirements('system-design', [req('a', 'behavioural')])).toBe(false);
    expect(categoryHasRequirements('behavioural', [req('a', 'technical')])).toBe(false);
    expect(categoryHasRequirements('company-fit', [])).toBe(true);
  });
});

describe('reports in words', () => {
  const base: RegenerationReport = {
    section: 'questions',
    category: 'technical',
    kept: ['q1'],
    replaced: ['q2', 'q3'],
    added: ['q6'],
    skipped: [{ reason: 'tombstone', detail: 'x' }],
    days: null,
    gaps: { uncovered_must_ids: [], uncovered_ids: [] },
  };

  it('summarises questions and brief reports with the real counts', () => {
    expect(summarizeReport(base)).toBe('2 replaced, 1 added, 1 kept, 1 skipped.');
    expect(summarizeReport({ ...base, skipped: [] })).toBe('2 replaced, 1 added, 1 kept.');
  });

  it('summarises a schedule report by days', () => {
    const schedule: RegenerationReport = {
      ...base,
      section: 'schedule',
      category: null,
      kept: [],
      replaced: [],
      added: [],
      skipped: [],
      days: { kept: [2], reallocated: [1, 3] },
    };
    expect(summarizeReport(schedule)).toBe('2 days were re-planned, 1 pinned day was kept.');
    expect(summarizeReport({ ...schedule, days: { kept: [1, 2, 3], reallocated: [] } })).toBe(
      'No day was re-planned, 3 pinned days were kept.',
    );
  });

  it('explains every skip reason in plain words', () => {
    for (const reason of [
      'pinned',
      'edited',
      'on_pinned_day',
      'tombstone',
      'duplicate',
      'unknown_requirement',
      'no_schedulable_day',
    ] as const) {
      expect(describeSkip(reason).length).toBeGreaterThan(10);
    }
    expect(describeSkip('tombstone')).toMatch(/Deleted earlier/);
  });
});
