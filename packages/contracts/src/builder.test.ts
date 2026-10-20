import { describe, expect, it } from 'vitest';
import {
  BUILDER_STATE_VERSION,
  batchCaseSchema,
  batchOutputSchema,
  builderOperationSchema,
  builderDocumentResponseSchema,
  builderStateSchema,
  MAX_OPERATIONS_PER_REQUEST,
  operationsRequestSchema,
  regenerationApplySchema,
  regenerationReportSchema,
  regenerationRequestSchema,
  researchSnapshotSchema,
  kitSchema,
  type BuilderState,
} from './index.js';

const state = (over: Partial<BuilderState> = {}): BuilderState => ({
  version: BUILDER_STATE_VERSION,
  requested_days: 7,
  next_ids: { question: 3, flashcard: 2, requirement: 2 },
  questions: [
    { id: 'q1', origin: 'generated', edited: false, pinned: false },
    { id: 'q2', origin: 'manual', edited: false, pinned: true },
  ],
  flashcards: [{ id: 'f1', origin: 'generated', edited: true, pinned: false }],
  requirements: [{ id: 'r1', origin: 'generated', edited: false, pinned: false }],
  brief: { edited: false, pinned: false },
  days: [{ day: 1, edited: false, pinned: false, focus_manual: false, minutes_manual: false }],
  tombstones: [{ kind: 'question', id: 'q9', match_key: 'a deleted question' }],
  ...over,
});

describe('builderStateSchema', () => {
  it('accepts a complete state and survives a JSON round trip unchanged', () => {
    const parsed = builderStateSchema.parse(state());
    expect(parsed).toEqual(state());
    expect(builderStateSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it('accepts a state with no items and no tombstones', () => {
    expect(
      builderStateSchema.safeParse(
        state({ questions: [], flashcards: [], requirements: [], days: [], tombstones: [] }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ['another version', { version: 2 }],
    ['no version', { version: undefined }],
    ['zero requested days', { requested_days: 0 }],
    ['more than 60 requested days', { requested_days: 61 }],
    ['fractional requested days', { requested_days: 3.5 }],
    ['a zero counter', { next_ids: { question: 0, flashcard: 1, requirement: 1 } }],
    ['a negative counter', { next_ids: { question: -1, flashcard: 1, requirement: 1 } }],
    ['a fractional counter', { next_ids: { question: 1.5, flashcard: 1, requirement: 1 } }],
    ['a missing counter', { next_ids: { question: 1, flashcard: 1 } }],
    [
      'an unknown origin',
      { questions: [{ id: 'q1', origin: 'robot', edited: false, pinned: false }] },
    ],
    ['an empty id', { questions: [{ id: '', origin: 'generated', edited: false, pinned: false }] }],
    [
      'a non-boolean pin',
      { questions: [{ id: 'q1', origin: 'generated', edited: false, pinned: 'yes' }] },
    ],
    ['a missing brief', { brief: undefined }],
    [
      'day zero',
      {
        days: [
          { day: 0, edited: false, pinned: false, focus_manual: false, minutes_manual: false },
        ],
      },
    ],
    ['a day without manual flags', { days: [{ day: 1, edited: false, pinned: false }] }],
    ['an unknown tombstone kind', { tombstones: [{ kind: 'day', id: 'd1', match_key: 'x' }] }],
    ['an empty match key', { tombstones: [{ kind: 'question', id: 'q9', match_key: '' }] }],
  ])('rejects %s', (_name, over) => {
    expect(builderStateSchema.safeParse({ ...state(), ...over }).success).toBe(false);
  });

  it('rejects a manual item marked edited (manual items are never "edited")', () => {
    const r = builderStateSchema.safeParse(
      state({ questions: [{ id: 'q2', origin: 'manual', edited: true, pinned: false }] }),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['questions', 0, 'edited']);
  });

  it('rejects the same tombstone twice, but allows the same id in different families', () => {
    const dup = state({
      tombstones: [
        { kind: 'question', id: 'q9', match_key: 'a' },
        { kind: 'question', id: 'q9', match_key: 'b' },
      ],
    });
    expect(builderStateSchema.safeParse(dup).success).toBe(false);
    const different = state({
      tombstones: [
        { kind: 'question', id: 'x1', match_key: 'a' },
        { kind: 'flashcard', id: 'x1', match_key: 'b' },
      ],
    });
    expect(builderStateSchema.safeParse(different).success).toBe(true);
  });

  it('treats an id like "__proto__" as plain data', () => {
    const r = builderStateSchema.parse(
      state({
        questions: [{ id: '__proto__', origin: 'generated', edited: false, pinned: false }],
      }),
    );
    expect(r.questions[0]?.id).toBe('__proto__');
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
  });
});

describe('builderOperationSchema', () => {
  const GOOD = [
    { type: 'edit_question', id: 'q1', changes: { prompt: 'p' } },
    {
      type: 'add_question',
      question: {
        prompt: 'p',
        answer_outline: '',
        difficulty: 2,
        category: 'technical',
        requirement_ids: [],
      },
    },
    {
      type: 'add_question',
      day: 2,
      question: {
        prompt: 'p',
        answer_outline: '',
        difficulty: 2,
        category: 'company-fit',
        requirement_ids: ['r1'],
      },
    },
    { type: 'delete_question', id: 'q1' },
    { type: 'move_question', id: 'q1', to_index: 0 },
    { type: 'edit_flashcard', id: 'f1', changes: { back: 'b' } },
    { type: 'add_flashcard', flashcard: { front: 'f', back: '', requirement_ids: [] } },
    { type: 'delete_flashcard', id: 'f1' },
    { type: 'edit_brief', changes: { summary: 's' } },
    { type: 'edit_requirement', id: 'r1', changes: { priority: 'nice' } },
    { type: 'add_requirement', requirement: { text: 't', kind: 'domain', priority: 'must' } },
    { type: 'delete_requirement', id: 'r1' },
    { type: 'edit_day_focus', day: 1, focus: 'f' },
    { type: 'edit_day_minutes', day: 1, minutes: 30 },
    { type: 'edit_day_minutes', day: 1, minutes: null },
    { type: 'move_question_to_day', question_id: 'q1', to_day: 2, index: 0 },
    { type: 'set_pin', target: { kind: 'question', id: 'q1' }, pinned: true },
    { type: 'set_pin', target: { kind: 'day', day: 3 }, pinned: false },
    { type: 'set_pin', target: { kind: 'brief' }, pinned: true },
  ];
  it.each(GOOD)('accepts %j', (op) => {
    expect(builderOperationSchema.safeParse(op).success).toBe(true);
  });

  const BAD = [
    {},
    { type: 'add_day' },
    { type: 'delete_day', day: 1 },
    { type: 'edit_question', id: 'q1', changes: {} },
    { type: 'edit_question', id: 'q1', changes: { prompt: '  ' } },
    { type: 'edit_question', id: 'q1', changes: { difficulty: 0 } },
    { type: 'edit_brief', changes: {} },
    { type: 'edit_requirement', id: 'r1', changes: { priority: 'must-ish' } },
    { type: 'edit_day_focus', day: 1, focus: '' },
    { type: 'edit_day_minutes', day: 1, minutes: 1441 },
    { type: 'edit_day_minutes', day: 1 },
    { type: 'move_question_to_day', question_id: 'q1', to_day: 0 },
    { type: 'move_question', id: 'q1', to_index: 1.5 },
    { type: 'set_pin', target: { kind: 'day' }, pinned: true },
    { type: 'set_pin', target: { kind: 'brief' } },
    { type: 'add_question', question: { prompt: 'p' } },
  ];
  it.each(BAD)('rejects %j', (op) => {
    expect(builderOperationSchema.safeParse(op).success).toBe(false);
  });

  it('trims text fields', () => {
    const r = builderOperationSchema.parse({ type: 'edit_day_focus', day: 1, focus: '  hi  ' });
    expect(r).toMatchObject({ focus: 'hi' });
  });
});

describe('Appendix A and B are untouched', () => {
  const kit = {
    source: {
      company: 'A',
      company_url: 'u',
      role: 'r',
      location: 'l',
      jd_chars: 1,
      researched_at: 't',
      pages_used: [],
    },
    company_brief: { summary: 's', what_they_do: 'w', sources: [] },
    role: { title: 't', seniority: 's', responsibilities: [], requirements: [] },
    questions: [],
    flashcards: [],
    schedule: { days_available: 1, days: [] },
    coverage: { uncovered_requirement_ids: [], passes: 0 },
  };

  it('a kit needs no builder fields and gains none: builder data is never part of a kit', () => {
    const parsed = kitSchema.parse(kit);
    expect(Object.keys(parsed)).toEqual([
      'source',
      'company_brief',
      'role',
      'questions',
      'flashcards',
      'schedule',
      'coverage',
    ]);
    const withState = kitSchema.parse({ ...kit, builder: state(), origin: 'manual' });
    expect(Object.keys(withState)).toEqual(Object.keys(parsed));
  });

  it('keeps the Appendix A field sets exactly', () => {
    expect(Object.keys(kitSchema.shape)).toEqual([
      'source',
      'company_brief',
      'role',
      'questions',
      'flashcards',
      'schedule',
      'coverage',
    ]);
    expect(Object.keys(kitSchema.shape.questions.element.shape)).toEqual([
      'id',
      'requirement_ids',
      'category',
      'prompt',
      'answer_outline',
      'difficulty',
    ]);
    expect(Object.keys(kitSchema.shape.flashcards.element.shape)).toEqual([
      'id',
      'front',
      'back',
      'requirement_ids',
    ]);
    expect(Object.keys(kitSchema.shape.schedule.shape.days.element.shape)).toEqual([
      'day',
      'focus',
      'question_ids',
      'minutes',
    ]);
    expect(Object.keys(kitSchema.shape.coverage.shape)).toEqual([
      'uncovered_requirement_ids',
      'passes',
    ]);
  });

  it('keeps the Appendix B field sets exactly', () => {
    expect(Object.keys(batchCaseSchema.shape)).toEqual(['id', 'jd', 'company_url', 'days']);
    expect(Object.keys(batchOutputSchema.shape)).toEqual(['version', 'generated_at', 'kits']);
    expect(batchCaseSchema.safeParse({ id: 'c', jd: '', company_url: '', days: 1 }).success).toBe(
      true,
    );
    expect(batchCaseSchema.safeParse({ id: 'c', jd: '', company_url: '', days: 0 }).success).toBe(
      false,
    );
  });
});

describe('researchSnapshotSchema', () => {
  const available = {
    status: 'available',
    captured_at: '2026-09-01T09:12:44Z',
    company_url: 'http://a.test/',
    company_name: 'A',
    crawl_status: 'ok',
    pages: [
      {
        url: 'http://a.test/',
        title: 'T',
        description: '',
        role: 'home',
        depth: 0,
        text: 'x',
        interview_mentions: ['m'],
        fetched_at: 't',
      },
    ],
    discussion: { provider: 'hn', status: 'no_results', retrieved_at: 't', items: [] },
  };

  it('represents absence explicitly, apart from an empty snapshot', () => {
    const none = researchSnapshotSchema.parse({ status: 'unavailable', reason: 'not_persisted' });
    expect(none).toEqual({ status: 'unavailable', reason: 'not_persisted' });
    expect(researchSnapshotSchema.safeParse({ status: 'unavailable' }).success).toBe(false);
    expect(
      researchSnapshotSchema.safeParse({ status: 'unavailable', reason: 'because' }).success,
    ).toBe(false);
    // "available" must carry its data: it can not be used to say "nothing"
    expect(researchSnapshotSchema.safeParse({ status: 'available' }).success).toBe(false);
  });

  it('accepts a full snapshot and rejects oversized or malformed ones', () => {
    expect(researchSnapshotSchema.safeParse(available).success).toBe(true);
    const long = { ...available, pages: [{ ...available.pages[0], text: 'x'.repeat(4_001) }] };
    expect(researchSnapshotSchema.safeParse(long).success).toBe(false);
    expect(
      researchSnapshotSchema.safeParse({
        ...available,
        pages: Array.from({ length: 13 }, () => available.pages[0]),
      }).success,
    ).toBe(false);
    expect(
      researchSnapshotSchema.safeParse({
        ...available,
        discussion: { ...available.discussion, status: 'weird' },
      }).success,
    ).toBe(false);
  });
});

describe('operationsRequestSchema', () => {
  it('needs a positive integer version and between one and the maximum number of operations', () => {
    const op = { type: 'set_pin', target: { kind: 'brief' }, pinned: true };
    expect(operationsRequestSchema.safeParse({ version: 1, operations: [op] }).success).toBe(true);
    for (const bad of [
      {},
      { version: 0, operations: [op] },
      { version: 1.5, operations: [op] },
      { version: 1, operations: [] },
      { version: 1, operations: Array.from({ length: MAX_OPERATIONS_PER_REQUEST + 1 }, () => op) },
      { version: 1, operations: op },
    ]) {
      expect(operationsRequestSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('leaves each operation to be checked one at a time by the builder', () => {
    expect(
      operationsRequestSchema.safeParse({ version: 1, operations: [{ type: 'nonsense' }] }).success,
    ).toBe(true);
  });
});

describe('builderDocumentResponseSchema', () => {
  const kit = {
    source: {
      company: 'A',
      company_url: 'u',
      role: 'r',
      location: 'l',
      jd_chars: 1,
      researched_at: 't',
      pages_used: [],
    },
    company_brief: { summary: 's', what_they_do: 'w', sources: [] },
    role: { title: 't', seniority: 's', responsibilities: [], requirements: [] },
    questions: [],
    flashcards: [],
    schedule: { days_available: 1, days: [] },
    coverage: { uncovered_requirement_ids: [], passes: 0 },
  };
  const response = {
    id: 'abc',
    version: 2,
    kit,
    builder: state({ questions: [], flashcards: [], requirements: [], days: [], tombstones: [] }),
    research: { status: 'unavailable', reason: 'not_persisted' },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  it('accepts the documented shape, with or without warnings', () => {
    expect(builderDocumentResponseSchema.safeParse(response).success).toBe(true);
    expect(
      builderDocumentResponseSchema.safeParse({
        ...response,
        warnings: [
          { severity: 'warning', code: 'UNSCHEDULED_QUESTION', path: 'questions[0]', message: 'm' },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects a response whose kit, state or research is not valid', () => {
    expect(
      builderDocumentResponseSchema.safeParse({ ...response, kit: { ...kit, coverage: undefined } })
        .success,
    ).toBe(false);
    expect(
      builderDocumentResponseSchema.safeParse({
        ...response,
        builder: { ...response.builder, version: 9 },
      }).success,
    ).toBe(false);
    expect(
      builderDocumentResponseSchema.safeParse({ ...response, research: undefined }).success,
    ).toBe(false);
    expect(builderDocumentResponseSchema.safeParse({ ...response, version: 0 }).success).toBe(
      false,
    );
  });
});

describe('regeneration contracts', () => {
  it('accepts exactly the supported sections, with a category only for questions', () => {
    for (const ok of [
      { section: 'brief' },
      { section: 'schedule' },
      { section: 'questions', category: 'technical' },
      { section: 'questions', category: 'company-fit' },
    ]) {
      expect(regenerationRequestSchema.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    }
    for (const bad of [
      {},
      { section: 'flashcards' },
      { section: 'questions' },
      { section: 'questions', category: 'trivia' },
      { section: 'practice' },
      'brief',
    ]) {
      expect(regenerationRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('the material a regeneration brings is checked: no blank text, no oversized brief, valid difficulty', () => {
    const question = { prompt: 'p', answer_outline: '', difficulty: 2, requirement_ids: ['r1'] };
    expect(
      regenerationApplySchema.safeParse({
        section: 'questions',
        category: 'technical',
        questions: [question],
      }).success,
    ).toBe(true);
    for (const bad of [
      { section: 'questions', category: 'technical', questions: [{ ...question, prompt: '  ' }] },
      { section: 'questions', category: 'technical', questions: [{ ...question, difficulty: 4 }] },
      {
        section: 'questions',
        category: 'technical',
        questions: Array.from({ length: 31 }, () => question),
      },
      { section: 'brief', brief: { summary: 'x'.repeat(5_001), what_they_do: '', sources: [] } },
      { section: 'brief', brief: { summary: '', what_they_do: '', sources: [''] } },
      { section: 'brief' },
    ]) {
      expect(regenerationApplySchema.safeParse(bad).success).toBe(false);
    }
    expect(regenerationApplySchema.safeParse({ section: 'schedule' }).success).toBe(true);
  });

  it('is not a builder operation: the operations endpoint cannot be used to submit generated content', () => {
    const apply = { section: 'schedule' };
    expect(builderOperationSchema.safeParse(apply).success).toBe(false);
    expect(builderOperationSchema.safeParse({ type: 'regenerate', ...apply }).success).toBe(false);
  });

  it('a report names what was kept, replaced, added and skipped, and the gaps that remain', () => {
    const report = {
      section: 'questions',
      category: 'technical',
      kept: ['q1'],
      replaced: ['q2'],
      added: ['q5'],
      skipped: [{ reason: 'tombstone', detail: 'Deleted earlier.' }],
      days: null,
      gaps: { uncovered_must_ids: ['r4'], uncovered_ids: ['r4'] },
    };
    expect(regenerationReportSchema.safeParse(report).success).toBe(true);
    expect(
      regenerationReportSchema.safeParse({
        ...report,
        skipped: [{ reason: 'because', detail: 'x' }],
      }).success,
    ).toBe(false);
    expect(
      regenerationReportSchema.safeParse({
        ...report,
        days: { kept: [1], reallocated: [2] },
        section: 'schedule',
        category: null,
      }).success,
    ).toBe(true);
  });
});
