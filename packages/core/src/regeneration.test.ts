import { describe, expect, it } from 'vitest';
import type { BuilderOperation, Kit, RegenerationApply } from '@trao/contracts';
import {
  applyOperations,
  checkBuilderDocument,
  createBuilderDocument,
  type BuilderDocument,
} from './builder';
import { makeKit as smallKit, question, req } from './fixtures';
import { applyRegeneration, normalizeForMatch, tombstoneMatches } from './regeneration';
import { validateKit } from './validate';

/** 4 requirements, 5 questions in 4 categories, 1 flashcard, 3 days. r4 (a must-have) has no question. */
function kit(): Kit {
  const k = smallKit();
  k.role.requirements = [
    req('r1', 'must', 'Node.js APIs'),
    { ...req('r2', 'nice', 'Kafka'), kind: 'technical' },
    { ...req('r3', 'must', 'Mentoring'), kind: 'behavioural' },
    { ...req('r4', 'must', 'Payments domain'), kind: 'domain' },
  ];
  k.questions = [
    question('q1', ['r1'], { difficulty: 3, prompt: 'Explain the event loop' }),
    question('q2', ['r2'], { difficulty: 1, prompt: 'What is a Kafka partition' }),
    question('q3', ['r3'], { category: 'behavioural', prompt: 'Tell me about mentoring' }),
    question('q4', ['r1'], { category: 'system-design', prompt: 'Design a ledger' }),
    question('q5', [], { category: 'company-fit', prompt: 'Why Acme' }),
  ];
  k.flashcards = [{ id: 'f1', front: 'Loop?', back: 'Phases.', requirement_ids: ['r1'] }];
  k.schedule = {
    days_available: 3,
    days: [
      { day: 1, focus: 'Day one', question_ids: ['q1', 'q3'], minutes: 35 },
      { day: 2, focus: 'Day two', question_ids: ['q2', 'q4'], minutes: 35 },
      { day: 3, focus: 'Day three', question_ids: ['q5'], minutes: 15 },
    ],
  };
  k.coverage = { uncovered_requirement_ids: ['r4'], passes: 2 };
  return k;
}

function start(ops: BuilderOperation[] = []): BuilderDocument {
  const created = createBuilderDocument(kit());
  if (!created.ok) throw new Error(`fixture invalid: ${JSON.stringify(created.error)}`);
  if (ops.length === 0) return created.document;
  const applied = applyOperations(created.document, ops);
  if (!applied.ok) throw new Error(`fixture operations refused: ${JSON.stringify(applied.error)}`);
  return applied.document;
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function regenerate(doc: BuilderDocument, input: RegenerationApply) {
  const r = applyRegeneration(doc, input);
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r;
}
const candidate = (prompt: string, requirement_ids: string[] = ['r1'], difficulty = 2) => ({
  prompt,
  answer_outline: '- a\n- b',
  difficulty,
  requirement_ids,
});
const technical = (...questions: ReturnType<typeof candidate>[]): RegenerationApply => ({
  section: 'questions',
  category: 'technical',
  questions,
});
const ids = (doc: BuilderDocument, category?: string) =>
  doc.kit.questions.filter((q) => !category || q.category === category).map((q) => q.id);
const day = (doc: BuilderDocument, n: number) => doc.kit.schedule.days.find((d) => d.day === n)!;

describe('matching deleted items', () => {
  it('equal after normalising case, spacing and punctuation', () => {
    const t = { match_key: 'explain the event loop' };
    for (const text of [
      'Explain the event loop',
      'EXPLAIN THE EVENT LOOP?',
      '  explain   the\tEvent-Loop. ',
      'Explain the event loop!!!',
      'Ｅｘｐｌａｉｎ the event loop', // full-width letters fold to the same text
    ]) {
      expect(tombstoneMatches(text, t), text).toBe(true);
    }
  });

  it('near-matches are NOT matches: different or extra words, other order, shared phrases', () => {
    const t = { match_key: 'explain the event loop' };
    for (const text of [
      'Explain the event loop in Node.js',
      'Explain event loop',
      'Describe the event loop',
      'The event loop: explain',
      'What is the event loop and how does it differ from threads?',
      'Explain the event',
      '',
    ]) {
      expect(tombstoneMatches(text, t), text).toBe(false);
    }
  });

  it('an empty comparison key never matches anything', () => {
    expect(tombstoneMatches('???', { match_key: '!!!' })).toBe(false);
    expect(normalizeForMatch('  A–B / c  ')).toBe('a b c');
  });

  it('understands the keys the builder stores, including those it stores for text-less items', () => {
    expect(
      tombstoneMatches('Explain the event loop', { match_key: 'explain the event loop' }),
    ).toBe(true);
    expect(tombstoneMatches('q7', { match_key: 'q7' })).toBe(true);
  });
});

describe('regenerating one category of questions', () => {
  it('replaces the generated, untouched questions of that category and nothing else', () => {
    const doc = start();
    const r = regenerate(
      doc,
      technical(
        candidate('How does libuv schedule I/O?'),
        candidate('What is backpressure?', ['r2']),
      ),
    );
    expect(ids(r.document, 'technical')).toEqual(['q6', 'q7']);
    // every other category is byte-for-byte what it was
    for (const cat of ['behavioural', 'system-design', 'company-fit']) {
      expect(r.document.kit.questions.filter((q) => q.category === cat)).toEqual(
        doc.kit.questions.filter((q) => q.category === cat),
      );
    }
    expect(r.document.kit.flashcards).toEqual(doc.kit.flashcards);
    expect(r.document.kit.role).toEqual(doc.kit.role);
    expect(r.document.kit.company_brief).toEqual(doc.kit.company_brief);
    expect(r.report).toMatchObject({
      section: 'questions',
      category: 'technical',
      replaced: ['q1', 'q2'],
      added: ['q6', 'q7'],
      kept: [],
    });
    expect(validateKit(r.document.kit, { requestedDays: 3 }).ok).toBe(true);
    expect(checkBuilderDocument(r.document).ok).toBe(true);
  });

  it('new questions are generated, unedited and unpinned, in the right category, with refs from the candidate', () => {
    const r = regenerate(
      start(),
      technical(candidate('How does libuv schedule I/O?', ['r1', 'r2'], 3)),
    );
    const added = r.document.kit.questions.find((q) => q.id === 'q6')!;
    expect(added).toMatchObject({
      category: 'technical',
      requirement_ids: ['r1', 'r2'],
      difficulty: 3,
    });
    expect(r.document.state.questions.find((m) => m.id === 'q6')).toEqual({
      id: 'q6',
      origin: 'generated',
      edited: false,
      pinned: false,
    });
  });

  it('keeps manual, edited and pinned questions, with their ids, and says why', () => {
    const doc = start([
      { type: 'edit_question', id: 'q1', changes: { prompt: 'My own wording' } },
      { type: 'set_pin', target: { kind: 'question', id: 'q2' }, pinned: true },
      {
        type: 'add_question',
        question: {
          prompt: 'Manual technical',
          answer_outline: '',
          difficulty: 1,
          category: 'technical',
          requirement_ids: ['r1'],
        },
      },
    ]);
    const r = regenerate(doc, technical(candidate('Fresh one')));
    expect(ids(r.document, 'technical')).toEqual(['q1', 'q2', 'q6', 'q7']);
    expect(r.document.kit.questions.find((q) => q.id === 'q1')?.prompt).toBe('My own wording');
    expect(r.report.kept).toEqual(['q1', 'q2', 'q6']);
    expect(r.report.skipped.map((s) => s.reason)).toEqual(['edited', 'pinned']);
    expect(r.report.replaced).toEqual([]);
    expect(r.document.state.questions.filter((m) => ['q1', 'q2', 'q6'].includes(m.id))).toEqual(
      doc.state.questions.filter((m) => ['q1', 'q2', 'q6'].includes(m.id)),
    );
  });

  it('keeps a generated question that sits on a pinned day, so the pinned allocation is not disturbed', () => {
    const doc = start([{ type: 'set_pin', target: { kind: 'day', day: 1 }, pinned: true }]);
    const r = regenerate(doc, technical(candidate('Fresh')));
    expect(day(r.document, 1)).toEqual(day(doc, 1));
    expect(ids(r.document, 'technical')).toContain('q1');
    expect(r.report.kept).toContain('q1');
    expect(r.report.skipped).toContainEqual(expect.objectContaining({ reason: 'on_pinned_day' }));
    expect(r.report.replaced).toEqual(['q2']);
  });

  it('puts new questions on the unpinned day with the fewest questions and recalculates that day', () => {
    const doc = start();
    const r = regenerate(doc, technical(candidate('A'), candidate('B', ['r2'])));
    // q1 and q2 are removed: day 1 [q3], day 2 [q4], day 3 [q5]; each new one takes the emptiest, earliest day
    expect(day(r.document, 1).question_ids).toEqual(['q3', 'q6']);
    expect(day(r.document, 2).question_ids).toEqual(['q4', 'q7']);
    expect(r.document.kit.schedule.days.flatMap((d) => d.question_ids).sort()).toEqual(
      ids(r.document).sort(),
    );
  });

  it('does not touch a day focus or minutes the user set', () => {
    const doc = start([
      { type: 'edit_day_focus', day: 1, focus: 'My focus' },
      { type: 'edit_day_minutes', day: 1, minutes: 99 },
    ]);
    const r = regenerate(doc, technical(candidate('Fresh')));
    expect(day(r.document, 1).focus).toBe('My focus');
    expect(day(r.document, 1).minutes).toBe(99);
  });

  it('never reintroduces a deleted question: an exact match is dropped, a near-match is kept', () => {
    const doc = start([{ type: 'delete_question', id: 'q1' }]); // "Explain the event loop"
    const r = regenerate(
      doc,
      technical(
        candidate('EXPLAIN the event  loop?'), // exactly the deleted question, re-typed
        candidate('Explain the event loop in Node.js and libuv'), // a different question that shares words
        candidate('Why is the event loop single threaded?'),
      ),
    );
    const prompts = r.document.kit.questions.map((q) => q.prompt);
    expect(prompts).not.toContain('EXPLAIN the event  loop?');
    expect(prompts).toContain('Explain the event loop in Node.js and libuv');
    expect(prompts).toContain('Why is the event loop single threaded?');
    expect(r.report.skipped).toContainEqual(expect.objectContaining({ reason: 'tombstone' }));
    expect(r.report.skipped.filter((s) => s.reason === 'tombstone')).toHaveLength(1);
    // the tombstone is still there, untouched
    expect(r.document.state.tombstones).toEqual(doc.state.tombstones);
  });

  it('drops candidates that repeat each other or a retained question, and ones naming unknown requirements', () => {
    const doc = start();
    const r = regenerate(
      doc,
      technical(
        candidate('Design a ledger'), // same as the retained system-design question q4
        candidate('Unique one'),
        candidate('unique one!'), // repeats the previous candidate
        candidate('Bad ref', ['r99']),
      ),
    );
    expect(r.report.skipped.map((s) => s.reason).sort()).toEqual([
      'duplicate',
      'duplicate',
      'unknown_requirement',
    ]);
    expect(ids(r.document, 'technical')).toEqual(['q6']);
  });

  it('does not add a question when every day is pinned, and says so', () => {
    const doc = start([
      { type: 'set_pin', target: { kind: 'day', day: 1 }, pinned: true },
      { type: 'set_pin', target: { kind: 'day', day: 2 }, pinned: true },
      { type: 'set_pin', target: { kind: 'day', day: 3 }, pinned: true },
    ]);
    const r = regenerate(doc, technical(candidate('Fresh')));
    expect(r.report.added).toEqual([]);
    expect(r.report.skipped).toContainEqual(
      expect.objectContaining({ reason: 'no_schedulable_day' }),
    );
    expect(r.document.kit.schedule).toEqual(doc.kit.schedule);
    expect(ids(r.document, 'technical')).toEqual(['q1', 'q2']); // both are on pinned days, so both stay
  });

  it('allocates ids from the persistent counters and never reuses one, even the highest deleted id', () => {
    const doc = start([
      {
        type: 'add_question',
        question: {
          prompt: 'Temp',
          answer_outline: '',
          difficulty: 1,
          category: 'technical',
          requirement_ids: [],
        },
      },
      { type: 'delete_question', id: 'q6' },
    ]);
    expect(doc.state.next_ids.question).toBe(7);
    const r = regenerate(doc, technical(candidate('Fresh')));
    expect(r.report.added).toEqual(['q7']);
    expect(r.document.state.next_ids.question).toBe(8);
    expect(r.document.state.tombstones.some((t) => t.id === 'q6')).toBe(false); // a manual item left no tombstone
  });

  it('repeated regeneration never collides on ids and never resurrects deleted items', () => {
    let doc = start();
    const seen = new Set<string>();
    for (let round = 0; round < 4; round++) {
      // the generator offers the same questions every time, including a deleted one
      const r = regenerate(
        doc,
        technical(
          candidate('Explain the event loop'),
          candidate('Round question'),
          candidate(`Question ${round}`),
        ),
      );
      doc = r.document;
      for (const id of r.report.added) {
        expect(seen.has(id), id).toBe(false);
        seen.add(id);
      }
      expect(new Set(ids(doc)).size).toBe(ids(doc).length);
      if (round === 0) {
        // after the first round, delete a regenerated question; it must stay deleted
        const victim = doc.kit.questions.find((q) => q.prompt === 'Round question')!;
        const deleted = applyOperations(doc, [{ type: 'delete_question', id: victim.id }]);
        if (!deleted.ok) throw new Error('delete refused');
        doc = deleted.document;
      }
    }
    expect(
      doc.kit.questions.filter((q) => normalizeForMatch(q.prompt) === 'round question'),
    ).toHaveLength(0);
    expect(checkBuilderDocument(doc).ok).toBe(true);
    expect(doc.state.next_ids.question).toBeGreaterThan(
      Math.max(...[...seen].map((id) => Number(id.slice(1)))),
    );
  });

  it('reports a must-have left uncovered instead of hiding it', () => {
    const r = regenerate(start(), technical(candidate('Only about Kafka', ['r2'])));
    // r1 (must) was covered by q1 (replaced) and q4 (system design, kept): still covered
    expect(r.report.gaps.uncovered_must_ids).toEqual(['r4']);
    const gone = regenerate(
      start([{ type: 'delete_question', id: 'q4' }]),
      technical(candidate('Only about Kafka', ['r2'])),
    );
    expect(gone.report.gaps.uncovered_must_ids).toEqual(['r1', 'r4']);
    expect(gone.document.kit.coverage.uncovered_requirement_ids).toEqual(['r1', 'r4']);
    expect(gone.document.kit.coverage.passes).toBe(2);
  });

  it('works for each category and leaves the others alone', () => {
    const doc = start();
    const r = regenerate(doc, {
      section: 'questions',
      category: 'behavioural',
      questions: [candidate('Describe a conflict you resolved', ['r3'])],
    });
    expect(ids(r.document, 'behavioural')).toEqual(['q6']);
    expect(ids(r.document, 'technical')).toEqual(['q1', 'q2']);
    const fit = regenerate(doc, {
      section: 'questions',
      category: 'company-fit',
      questions: [candidate('What draws you to payments?', [])],
    });
    expect(ids(fit.document, 'company-fit')).toEqual(['q6']);
  });
});

describe('regenerating the company brief', () => {
  const brief: RegenerationApply = {
    section: 'brief',
    brief: {
      summary: 'A new, verified summary.',
      what_they_do: 'Payments.',
      sources: ['http://a.test/'],
    },
  };

  it('replaces an untouched generated brief, and only the brief', () => {
    const doc = start();
    const r = regenerate(doc, brief);
    expect(r.document.kit.company_brief).toEqual({
      summary: 'A new, verified summary.',
      what_they_do: 'Payments.',
      sources: ['http://a.test/'],
    });
    expect(r.document.kit.questions).toEqual(doc.kit.questions);
    expect(r.document.kit.schedule).toEqual(doc.kit.schedule);
    expect(r.document.state.brief).toEqual({ edited: false, pinned: false });
    expect(r.report).toMatchObject({ section: 'brief', replaced: ['brief'], kept: [] });
  });

  it('keeps a brief the user edited or pinned, unchanged, and says so', () => {
    for (const [op, reason] of [
      [{ type: 'edit_brief', changes: { summary: 'Mine' } }, 'edited'],
      [{ type: 'set_pin', target: { kind: 'brief' }, pinned: true }, 'pinned'],
    ] as const) {
      const doc = start([op as BuilderOperation]);
      const r = regenerate(doc, brief);
      expect(r.document.kit.company_brief).toEqual(doc.kit.company_brief);
      expect(r.report).toMatchObject({ kept: ['brief'], replaced: [] });
      expect(r.report.skipped[0]?.reason).toBe(reason);
    }
  });
});

describe('regenerating the schedule', () => {
  it('keeps pinned days exactly, re-spreads the rest, and never changes the number of days', () => {
    const doc = start([{ type: 'set_pin', target: { kind: 'day', day: 2 }, pinned: true }]);
    const r = regenerate(doc, { section: 'schedule' });
    expect(day(r.document, 2)).toEqual(day(doc, 2));
    expect(r.report.days).toEqual({ kept: [2], reallocated: [1, 3] });
    expect(r.document.kit.schedule.days_available).toBe(3);
    expect(r.document.kit.schedule.days.map((d) => d.day)).toEqual([1, 2, 3]);
    // questions 1, 3 and 5 are shared over days 1 and 3
    expect(day(r.document, 1).question_ids.length + day(r.document, 3).question_ids.length).toBe(3);
    // every question exactly once
    expect(r.document.kit.schedule.days.flatMap((d) => d.question_ids).sort()).toEqual([
      'q1',
      'q2',
      'q3',
      'q4',
      'q5',
    ]);
    expect(r.document.state.requested_days).toBe(3);
  });

  it('does not touch questions, flashcards, the brief or provenance', () => {
    const doc = start([{ type: 'set_pin', target: { kind: 'question', id: 'q1' }, pinned: true }]);
    const r = regenerate(doc, { section: 'schedule' });
    expect(r.document.kit.questions).toEqual(doc.kit.questions);
    expect(r.document.kit.flashcards).toEqual(doc.kit.flashcards);
    expect(r.document.kit.company_brief).toEqual(doc.kit.company_brief);
    expect(r.document.state.questions).toEqual(doc.state.questions);
    expect(r.document.state.tombstones).toEqual(doc.state.tombstones);
    expect(r.document.state.next_ids).toEqual(doc.state.next_ids);
  });

  it('keeps focus and minutes the user set on a day that is not pinned, while its questions are re-spread', () => {
    const doc = start([
      { type: 'edit_day_focus', day: 1, focus: 'Warm-up' },
      { type: 'edit_day_minutes', day: 3, minutes: 77 },
    ]);
    const r = regenerate(doc, { section: 'schedule' });
    expect(day(r.document, 1).focus).toBe('Warm-up');
    expect(day(r.document, 3).minutes).toBe(77);
    expect(r.document.state.days.map((d) => [d.focus_manual, d.minutes_manual])).toEqual(
      doc.state.days.map((d) => [d.focus_manual, d.minutes_manual]),
    );
  });

  it('with every day pinned keeps the schedule and says why', () => {
    const doc = start(
      [1, 2, 3].map(
        (d) =>
          ({ type: 'set_pin', target: { kind: 'day', day: d }, pinned: true }) as BuilderOperation,
      ),
    );
    const r = regenerate(doc, { section: 'schedule' });
    expect(r.document.kit.schedule).toEqual(doc.kit.schedule);
    expect(r.report.skipped[0]?.reason).toBe('pinned');
    expect(r.report.days).toEqual({ kept: [1, 2, 3], reallocated: [] });
  });

  it('schedules a question that was unscheduled, never silently dropping a question', () => {
    const doc = start();
    const loose = clone(doc);
    loose.kit.schedule.days[2]!.question_ids = []; // q5 is now unscheduled (a legal "warning" state)
    const r = regenerate(loose, { section: 'schedule' });
    expect(r.document.kit.schedule.days.flatMap((d) => d.question_ids).sort()).toEqual([
      'q1',
      'q2',
      'q3',
      'q4',
      'q5',
    ]);
    expect(r.document.kit.questions).toHaveLength(5);
  });

  it('reports coverage gaps honestly and does not invent coverage', () => {
    const r = regenerate(start(), { section: 'schedule' });
    expect(r.report.gaps).toEqual({ uncovered_must_ids: ['r4'], uncovered_ids: ['r4'] });
    expect(r.document.kit.coverage.uncovered_requirement_ids).toEqual(['r4']);
  });

  it('is deterministic', () => {
    const doc = start([{ type: 'set_pin', target: { kind: 'day', day: 2 }, pinned: true }]);
    expect(JSON.stringify(regenerate(doc, { section: 'schedule' }))).toBe(
      JSON.stringify(regenerate(doc, { section: 'schedule' })),
    );
  });
});

describe('every regeneration', () => {
  const inputs: RegenerationApply[] = [
    { section: 'brief', brief: { summary: 's', what_they_do: 'w', sources: [] } },
    { section: 'questions', category: 'technical', questions: [candidate('X')] },
    { section: 'schedule' },
  ];

  it.each(inputs.map((i) => [i.section, i] as const))(
    '%s: does not mutate its input and returns a consistent, valid document',
    (_n, input) => {
      const doc = start();
      const before = JSON.stringify(doc);
      const r = regenerate(doc, input);
      expect(JSON.stringify(doc)).toBe(before);
      expect(r.document.kit).not.toBe(doc.kit);
      expect(checkBuilderDocument(r.document).ok).toBe(true);
      expect(validateKit(r.document.kit, { requestedDays: 3 }).ok).toBe(true);
      expect(r.document.state.requested_days).toBe(3);
    },
  );

  it('refuses malformed input and a document that is already inconsistent, changing nothing', () => {
    const doc = start();
    for (const bad of [
      null,
      {},
      { section: 'flashcards' },
      { section: 'questions', category: 'trivia', questions: [] },
      {
        section: 'questions',
        category: 'technical',
        questions: [{ prompt: ' ', answer_outline: '', difficulty: 2, requirement_ids: [] }],
      },
    ]) {
      const r = applyRegeneration(doc, bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_OPERATION');
    }
    const broken: BuilderDocument = { ...doc, state: { ...doc.state, questions: [] } };
    const r = applyRegeneration(broken, { section: 'schedule' });
    expect(!r.ok && r.error.code).toBe('STATE_INCONSISTENT');
  });

  it('cannot be submitted as an ordinary builder operation', () => {
    const doc = start();
    const r = applyOperations(doc, [{ section: 'schedule' }]);
    expect(r.ok).toBe(false);
  });
});
