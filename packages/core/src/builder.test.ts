import { describe, expect, it } from 'vitest';
import { kitSchema, type BuilderOperation, type Kit } from '@trao/contracts';
import {
  applyOperation,
  applyOperations,
  checkBuilderDocument,
  createBuilderDocument,
  matchKey,
  scheduleTotals,
  type BuilderDocument,
} from './builder.js';
import { checkCoverage } from './coverage.js';
import { makeKit as smallKit, question, req } from './fixtures.js';
import { allocateSchedule } from './schedule.js';
import { validateKit } from './validate.js';

/** 3 requirements (2 must), 4 questions, 2 flashcards, 3 days. Every must-have has a question. */
function richKit(): Kit {
  const kit = smallKit();
  kit.role.requirements = [
    req('r1', 'must', 'Node.js APIs'),
    req('r2', 'nice', 'Kafka'),
    req('r3', 'must', 'Stakeholder communication'),
  ];
  kit.questions = [
    question('q1', ['r1'], { difficulty: 3 }),
    question('q2', ['r2'], { difficulty: 1 }),
    question('q3', ['r3'], { difficulty: 2, category: 'behavioural' }),
    question('q4', ['r1', 'r3'], { difficulty: 2 }),
  ];
  kit.flashcards = [
    { id: 'f1', front: 'Event loop?', back: 'Phases.', requirement_ids: ['r1'] },
    { id: 'f2', front: 'Partition?', back: 'Ordering unit.', requirement_ids: ['r2'] },
  ];
  kit.schedule = {
    days_available: 3,
    days: [
      { day: 1, focus: 'Day one', question_ids: ['q1', 'q4'], minutes: 35 },
      { day: 2, focus: 'Day two', question_ids: ['q3'], minutes: 15 },
      { day: 3, focus: 'Day three', question_ids: ['q2'], minutes: 10 },
    ],
  };
  kit.coverage = { uncovered_requirement_ids: [], passes: 2 };
  return kit;
}

function start(kit: Kit = richKit()): BuilderDocument {
  const r = createBuilderDocument(kit);
  if (!r.ok) throw new Error(`fixture invalid: ${JSON.stringify(r.error)}`);
  return r.document;
}

/** Applies one operation and returns the new document, failing the test if it was refused. */
function ok(doc: BuilderDocument, op: BuilderOperation | Record<string, unknown>): BuilderDocument {
  const r = applyOperation(doc, op);
  if (!r.ok) throw new Error(`operation refused: ${JSON.stringify(r.error)}`);
  return r.document;
}
function refused(doc: BuilderDocument, op: unknown) {
  const r = applyOperation(doc, op);
  if (r.ok) throw new Error('operation was accepted');
  return r.error;
}
const meta = (
  doc: BuilderDocument,
  list: 'questions' | 'flashcards' | 'requirements',
  id: string,
) => doc.state[list].find((m) => m.id === id)!;
const q = (doc: BuilderDocument, id: string) => doc.kit.questions.find((x) => x.id === id)!;
const day = (doc: BuilderDocument, n: number) => doc.kit.schedule.days.find((d) => d.day === n)!;

describe('createBuilderDocument', () => {
  it('records every item as generated, unedited and unpinned, with no tombstones', () => {
    const doc = start();
    for (const list of ['questions', 'flashcards', 'requirements'] as const) {
      expect(doc.state[list].every((m) => m.origin === 'generated' && !m.edited && !m.pinned)).toBe(
        true,
      );
    }
    expect(doc.state.brief).toEqual({ edited: false, pinned: false });
    expect(doc.state.days).toHaveLength(3);
    expect(
      doc.state.days.every((d) => !d.edited && !d.pinned && !d.focus_manual && !d.minutes_manual),
    ).toBe(true);
    expect(doc.state.tombstones).toEqual([]);
    expect(doc.state.requested_days).toBe(3);
  });

  it('starts the id counters above every existing id', () => {
    expect(start().state.next_ids).toEqual({ question: 5, flashcard: 3, requirement: 4 });
  });

  it('copes with ids that do not follow the q1 pattern', () => {
    const kit = richKit();
    kit.questions[0]!.id = 'custom';
    kit.schedule.days[0]!.question_ids[0] = 'custom';
    expect(start(kit).state.next_ids.question).toBe(5);
  });

  it('does not change the kit it was given and keeps it identical to Appendix A', () => {
    const kit = richKit();
    const before = JSON.stringify(kit);
    const doc = start(kit);
    expect(JSON.stringify(kit)).toBe(before);
    expect(doc.kit).toEqual(kit);
    expect(kitSchema.safeParse(doc.kit).success).toBe(true);
    expect(Object.keys(doc.kit)).toEqual(Object.keys(kit)); // no builder fields leak into the kit
  });

  it('refuses an invalid kit with the validation issues', () => {
    const kit = richKit();
    kit.coverage.uncovered_requirement_ids = ['r1']; // a lie
    const r = createBuilderDocument(kit);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('KIT_INVALID');
      expect(r.error.issues?.map((i) => i.code)).toContain('COVERAGE_MISMATCH');
    }
  });

  it('refuses a request length that does not match the schedule', () => {
    const r = createBuilderDocument(richKit(), { requestedDays: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error.issues?.[0]?.code ?? r.error.code).toMatch(
        /DAYS_REQUESTED_MISMATCH|KIT_INVALID/,
      );
  });
});

describe('checking a document', () => {
  it('rejects a state that fails its schema', () => {
    const doc = start();
    const bad = { ...doc, state: { ...doc.state, version: 2 } } as unknown as BuilderDocument;
    expect(checkBuilderDocument(bad)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE' },
    });
  });

  it('rejects missing, extra and repeated metadata', () => {
    const doc = start();
    const missing: BuilderDocument = {
      ...doc,
      state: { ...doc.state, questions: doc.state.questions.slice(1) },
    };
    expect(checkBuilderDocument(missing)).toMatchObject({
      ok: false,
      error: { code: 'STATE_INCONSISTENT' },
    });
    const extra: BuilderDocument = {
      ...doc,
      state: {
        ...doc.state,
        flashcards: [
          ...doc.state.flashcards,
          { id: 'f9', origin: 'manual', edited: false, pinned: false },
        ],
      },
    };
    expect(checkBuilderDocument(extra)).toMatchObject({
      ok: false,
      error: { code: 'STATE_INCONSISTENT' },
    });
    const dup: BuilderDocument = {
      ...doc,
      state: {
        ...doc.state,
        requirements: [...doc.state.requirements, doc.state.requirements[0]!],
      },
    };
    expect(checkBuilderDocument(dup)).toMatchObject({
      ok: false,
      error: { code: 'STATE_INCONSISTENT' },
    });
  });

  it('rejects a counter that would reuse an id, and a tombstone for an item that exists', () => {
    const doc = start();
    const low: BuilderDocument = {
      ...doc,
      state: { ...doc.state, next_ids: { ...doc.state.next_ids, question: 4 } },
    };
    expect(checkBuilderDocument(low)).toMatchObject({
      ok: false,
      error: { code: 'STATE_INCONSISTENT' },
    });
    const both: BuilderDocument = {
      ...doc,
      state: { ...doc.state, tombstones: [{ kind: 'question', id: 'q1', match_key: 'x' }] },
    };
    expect(checkBuilderDocument(both)).toMatchObject({
      ok: false,
      error: { code: 'STATE_INCONSISTENT' },
    });
  });

  it('rejects day metadata that does not match the schedule', () => {
    const doc = start();
    const bad: BuilderDocument = {
      ...doc,
      state: { ...doc.state, days: doc.state.days.slice(0, 2) },
    };
    expect(checkBuilderDocument(bad)).toMatchObject({
      ok: false,
      error: { code: 'STATE_INCONSISTENT' },
    });
  });

  it('rejects a kit with duplicate ids or a dangling reference', () => {
    const doc = start();
    const dup = clone(doc);
    dup.kit.questions.push({ ...dup.kit.questions[0]! });
    expect(checkBuilderDocument(dup)).toMatchObject({ ok: false, error: { code: 'KIT_INVALID' } });
    const dangling = clone(doc);
    dangling.kit.questions[0]!.requirement_ids = ['r99'];
    const r = checkBuilderDocument(dangling);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error.issues?.map((i) => i.code)).toContain('UNKNOWN_REQUIREMENT_REFERENCE');
  });

  it('refuses every operation on an invalid document, naming that problem', () => {
    const doc = start();
    const bad: BuilderDocument = { ...doc, state: { ...doc.state, questions: [] } };
    expect(refused(bad, { type: 'set_pin', target: { kind: 'brief' }, pinned: true }).code).toBe(
      'STATE_INCONSISTENT',
    );
  });
});

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe('questions', () => {
  it('editing a generated question changes it, marks it edited, and leaves everything else alone', () => {
    const doc = start();
    const next = ok(doc, {
      type: 'edit_question',
      id: 'q2',
      changes: { prompt: 'New prompt', answer_outline: 'New outline' },
    });
    expect(q(next, 'q2')).toMatchObject({
      prompt: 'New prompt',
      answer_outline: 'New outline',
      id: 'q2',
    });
    expect(meta(next, 'questions', 'q2')).toEqual({
      id: 'q2',
      origin: 'generated',
      edited: true,
      pinned: false,
    });
    expect(meta(next, 'questions', 'q1').edited).toBe(false);
    expect(q(next, 'q1')).toEqual(q(doc, 'q1'));
    expect(next.state.next_ids).toEqual(doc.state.next_ids);
  });

  it('does not mark an item edited when nothing actually changed', () => {
    const doc = start();
    const next = ok(doc, {
      type: 'edit_question',
      id: 'q1',
      changes: { prompt: q(doc, 'q1').prompt, requirement_ids: ['r1'] },
    });
    expect(next).toEqual(doc);
  });

  it('trims the new prompt and refuses an empty one', () => {
    const doc = start();
    expect(
      q(ok(doc, { type: 'edit_question', id: 'q1', changes: { prompt: '  hi  ' } }), 'q1').prompt,
    ).toBe('hi');
    expect(refused(doc, { type: 'edit_question', id: 'q1', changes: { prompt: '   ' } }).code).toBe(
      'INVALID_OPERATION',
    );
  });

  it('pinning is independent of editing, in both orders', () => {
    const doc = start();
    const a = ok(
      ok(doc, { type: 'set_pin', target: { kind: 'question', id: 'q1' }, pinned: true }),
      {
        type: 'edit_question',
        id: 'q1',
        changes: { difficulty: 1 },
      },
    );
    expect(meta(a, 'questions', 'q1')).toMatchObject({ pinned: true, edited: true });
    const b = ok(ok(doc, { type: 'edit_question', id: 'q1', changes: { difficulty: 1 } }), {
      type: 'set_pin',
      target: { kind: 'question', id: 'q1' },
      pinned: true,
    });
    expect(meta(b, 'questions', 'q1')).toMatchObject({ pinned: true, edited: true });
    const c = ok(a, { type: 'set_pin', target: { kind: 'question', id: 'q1' }, pinned: false });
    expect(meta(c, 'questions', 'q1')).toMatchObject({ pinned: false, edited: true });
    const pinOnly = ok(doc, {
      type: 'set_pin',
      target: { kind: 'question', id: 'q3' },
      pinned: true,
    });
    expect(meta(pinOnly, 'questions', 'q3')).toMatchObject({ pinned: true, edited: false });
  });

  it('changing the category is an edit and does not move the question in the list', () => {
    const doc = start();
    const next = ok(doc, {
      type: 'edit_question',
      id: 'q1',
      changes: { category: 'system-design' },
    });
    expect(q(next, 'q1').category).toBe('system-design');
    expect(next.kit.questions.map((x) => x.id)).toEqual(['q1', 'q2', 'q3', 'q4']);
    expect(meta(next, 'questions', 'q1').edited).toBe(true);
  });

  it('reordering moves one question, keeps every id, and is not an edit', () => {
    const doc = start();
    const next = ok(doc, { type: 'move_question', id: 'q4', to_index: 0 });
    expect(next.kit.questions.map((x) => x.id)).toEqual(['q4', 'q1', 'q2', 'q3']);
    expect(next.state.questions).toEqual(doc.state.questions);
    expect(next.kit.schedule).toEqual(doc.kit.schedule);
    expect(
      ok(next, { type: 'move_question', id: 'q4', to_index: 3 }).kit.questions.map((x) => x.id),
    ).toEqual(['q1', 'q2', 'q3', 'q4']);
    expect(refused(doc, { type: 'move_question', id: 'q4', to_index: 4 }).code).toBe(
      'INDEX_OUT_OF_RANGE',
    );
    expect(refused(doc, { type: 'move_question', id: 'nope', to_index: 0 }).code).toBe('NOT_FOUND');
  });

  it('adds a manual question with a fresh id, on a day, and marks it manual and not edited', () => {
    const doc = start();
    const next = ok(doc, {
      type: 'add_question',
      question: {
        prompt: 'Why us?',
        answer_outline: '',
        difficulty: 1,
        category: 'company-fit',
        requirement_ids: ['r2'],
      },
    });
    expect(q(next, 'q5')).toMatchObject({ id: 'q5', prompt: 'Why us?', requirement_ids: ['r2'] });
    expect(meta(next, 'questions', 'q5')).toEqual({
      id: 'q5',
      origin: 'manual',
      edited: false,
      pinned: false,
    });
    expect(next.state.next_ids.question).toBe(6);
    // default day: the one with the fewest questions, earliest on a tie (days 2 and 3 have one each)
    expect(day(next, 2).question_ids).toEqual(['q3', 'q5']);
    expect(day(next, 2).minutes).toBe(25);
    expect(next.state.days[1]!.edited).toBe(true);
    expect(validateKit(next.kit, { requestedDays: 3 }).ok).toBe(true);
  });

  it('puts a new question on the day asked for, and refuses a day that does not exist', () => {
    const doc = start();
    const make = (extra: object) => ({
      type: 'add_question',
      question: {
        prompt: 'P',
        answer_outline: '',
        difficulty: 3,
        category: 'technical',
        requirement_ids: [],
      },
      ...extra,
    });
    expect(day(ok(doc, make({ day: 3 })), 3).question_ids).toEqual(['q2', 'q5']);
    expect(refused(doc, make({ day: 4 })).code).toBe('NOT_FOUND');
  });

  it('refuses a new question that references a requirement that does not exist', () => {
    const doc = start();
    const e = refused(doc, {
      type: 'add_question',
      question: {
        prompt: 'P',
        answer_outline: '',
        difficulty: 1,
        category: 'technical',
        requirement_ids: ['r42'],
      },
    });
    expect(e).toMatchObject({ code: 'UNKNOWN_REFERENCE', path: 'question.requirement_ids' });
  });

  it('removes repeated requirement references instead of storing them twice', () => {
    const doc = start();
    const next = ok(doc, {
      type: 'edit_question',
      id: 'q4',
      changes: { requirement_ids: ['r3', 'r3', 'r1'] },
    });
    expect(q(next, 'q4').requirement_ids).toEqual(['r3', 'r1']);
  });

  it('deleting a generated question leaves a tombstone, removes it from its day, and updates the day', () => {
    const doc = start();
    const next = ok(doc, { type: 'delete_question', id: 'q4' });
    expect(next.kit.questions.map((x) => x.id)).toEqual(['q1', 'q2', 'q3']);
    expect(day(next, 1).question_ids).toEqual(['q1']);
    expect(day(next, 1).minutes).toBe(20);
    expect(next.state.questions.map((m) => m.id)).toEqual(['q1', 'q2', 'q3']);
    expect(next.state.tombstones).toEqual([
      { kind: 'question', id: 'q4', match_key: matchKey(q(doc, 'q4').prompt, 'q4') },
    ]);
  });

  it('deleting a manual question leaves no tombstone', () => {
    const added = ok(start(), {
      type: 'add_question',
      question: {
        prompt: 'Mine',
        answer_outline: '',
        difficulty: 2,
        category: 'technical',
        requirement_ids: [],
      },
    });
    const next = ok(added, { type: 'delete_question', id: 'q5' });
    expect(next.state.tombstones).toEqual([]);
    expect(next.kit.questions.map((x) => x.id)).toEqual(['q1', 'q2', 'q3', 'q4']);
  });

  it('never reuses the id of a deleted question, including the highest one', () => {
    let doc = start();
    doc = ok(doc, { type: 'delete_question', id: 'q4' }); // the highest allocated id
    doc = ok(doc, {
      type: 'add_question',
      question: {
        prompt: 'New',
        answer_outline: '',
        difficulty: 1,
        category: 'technical',
        requirement_ids: [],
      },
    });
    expect(doc.kit.questions.map((x) => x.id)).toEqual(['q1', 'q2', 'q3', 'q5']);
    // add, delete the new one, add again: still moving forward
    doc = ok(doc, { type: 'delete_question', id: 'q5' });
    doc = ok(doc, {
      type: 'add_question',
      question: {
        prompt: 'Again',
        answer_outline: '',
        difficulty: 1,
        category: 'technical',
        requirement_ids: [],
      },
    });
    expect(doc.kit.questions.map((x) => x.id)).toEqual(['q1', 'q2', 'q3', 'q6']);
    expect(doc.state.next_ids.question).toBe(7);
  });

  it('refuses to start from a state whose counter would reuse a deleted id', () => {
    let doc = start();
    doc = ok(doc, { type: 'delete_question', id: 'q4' });
    const rolledBack: BuilderDocument = {
      ...doc,
      state: { ...doc.state, next_ids: { ...doc.state.next_ids, question: 4 } },
    };
    expect(
      refused(rolledBack, { type: 'set_pin', target: { kind: 'brief' }, pinned: true }).code,
    ).toBe('STATE_INCONSISTENT');
  });

  it('keeps the ids of unaffected items through any sequence of edits and moves', () => {
    let doc = start();
    doc = ok(doc, { type: 'move_question_to_day', question_id: 'q1', to_day: 3 });
    doc = ok(doc, { type: 'edit_question', id: 'q3', changes: { prompt: 'x' } });
    doc = ok(doc, { type: 'move_question', id: 'q3', to_index: 0 });
    expect(doc.kit.questions.map((x) => x.id).sort()).toEqual(['q1', 'q2', 'q3', 'q4']);
  });
});

describe('flashcards and the brief', () => {
  it('edits a flashcard, marking it edited only when something changed', () => {
    const doc = start();
    const next = ok(doc, {
      type: 'edit_flashcard',
      id: 'f1',
      changes: { back: 'Phases and microtasks.' },
    });
    expect(next.kit.flashcards[0]).toMatchObject({
      id: 'f1',
      front: 'Event loop?',
      back: 'Phases and microtasks.',
    });
    expect(meta(next, 'flashcards', 'f1').edited).toBe(true);
    expect(meta(next, 'flashcards', 'f2').edited).toBe(false);
    expect(ok(doc, { type: 'edit_flashcard', id: 'f1', changes: { back: 'Phases.' } })).toEqual(
      doc,
    );
  });

  it('adds a manual flashcard with a fresh id and deletes with a tombstone only for generated ones', () => {
    let doc = ok(start(), {
      type: 'add_flashcard',
      flashcard: { front: 'Mine', back: 'b', requirement_ids: ['r3'] },
    });
    expect(doc.kit.flashcards.map((f) => f.id)).toEqual(['f1', 'f2', 'f3']);
    expect(meta(doc, 'flashcards', 'f3')).toMatchObject({ origin: 'manual', edited: false });
    doc = ok(doc, { type: 'delete_flashcard', id: 'f3' });
    expect(doc.state.tombstones).toEqual([]);
    doc = ok(doc, { type: 'delete_flashcard', id: 'f2' });
    expect(doc.state.tombstones).toEqual([
      { kind: 'flashcard', id: 'f2', match_key: 'partition?' },
    ]);
    doc = ok(doc, {
      type: 'add_flashcard',
      flashcard: { front: 'Next', back: '', requirement_ids: [] },
    });
    expect(doc.kit.flashcards.map((f) => f.id)).toEqual(['f1', 'f4']); // f2 and f3 are never handed out again
  });

  it('refuses unknown references and unknown flashcards', () => {
    const doc = start();
    expect(
      refused(doc, { type: 'edit_flashcard', id: 'f1', changes: { requirement_ids: ['zzz'] } })
        .code,
    ).toBe('UNKNOWN_REFERENCE');
    expect(refused(doc, { type: 'delete_flashcard', id: 'zzz' }).code).toBe('NOT_FOUND');
    expect(
      refused(doc, {
        type: 'add_flashcard',
        flashcard: { front: ' ', back: '', requirement_ids: [] },
      }).code,
    ).toBe('INVALID_OPERATION');
  });

  it('edits the brief, marks it edited once something changed, and leaves its sources alone', () => {
    const doc = start();
    const next = ok(doc, { type: 'edit_brief', changes: { summary: 'A better summary.' } });
    expect(next.kit.company_brief).toEqual({
      ...doc.kit.company_brief,
      summary: 'A better summary.',
    });
    expect(next.state.brief).toEqual({ edited: true, pinned: false });
    expect(
      ok(doc, { type: 'edit_brief', changes: { summary: doc.kit.company_brief.summary } }).state
        .brief.edited,
    ).toBe(false);
    const pinned = ok(next, { type: 'set_pin', target: { kind: 'brief' }, pinned: true });
    expect(pinned.state.brief).toEqual({ edited: true, pinned: true });
  });
});

describe('requirements and coverage', () => {
  it('edits text, kind and priority, marks the requirement edited, and keeps coverage consistent', () => {
    const doc = start();
    const next = ok(doc, {
      type: 'edit_requirement',
      id: 'r2',
      changes: { text: 'Kafka Streams', kind: 'domain', priority: 'must' },
    });
    expect(next.kit.role.requirements[1]).toEqual({
      id: 'r2',
      text: 'Kafka Streams',
      kind: 'domain',
      priority: 'must',
    });
    expect(meta(next, 'requirements', 'r2').edited).toBe(true);
    expect(next.kit.coverage.uncovered_requirement_ids).toEqual([]);
  });

  it('refreshes the day focus that mentions an edited requirement, unless the user wrote that focus', () => {
    let doc = start();
    doc = ok(doc, { type: 'edit_requirement', id: 'r2', changes: { text: 'Event streaming' } });
    expect(day(doc, 3).focus).toContain('Event streaming');
    // a focus the user wrote is never overwritten
    let manual = start();
    manual = ok(manual, { type: 'edit_day_focus', day: 3, focus: 'My own focus' });
    manual = ok(manual, {
      type: 'edit_requirement',
      id: 'r2',
      changes: { text: 'Event streaming' },
    });
    expect(day(manual, 3).focus).toBe('My own focus');
  });

  it('adds a manual requirement, which starts out honestly uncovered', () => {
    const doc = ok(start(), {
      type: 'add_requirement',
      requirement: { text: 'Kubernetes', kind: 'technical', priority: 'must' },
    });
    expect(doc.kit.role.requirements.at(-1)).toEqual({
      id: 'r4',
      text: 'Kubernetes',
      kind: 'technical',
      priority: 'must',
    });
    expect(meta(doc, 'requirements', 'r4')).toMatchObject({ origin: 'manual', edited: false });
    expect(doc.kit.coverage.uncovered_requirement_ids).toEqual(['r4']);
    expect(checkCoverage(doc.kit.role.requirements, doc.kit.questions).uncovered_must_ids).toEqual([
      'r4',
    ]);
  });

  it('covering a gap with a question removes it from the uncovered list', () => {
    let doc = ok(start(), {
      type: 'add_requirement',
      requirement: { text: 'Kubernetes', kind: 'technical', priority: 'must' },
    });
    doc = ok(doc, { type: 'edit_question', id: 'q2', changes: { requirement_ids: ['r2', 'r4'] } });
    expect(doc.kit.coverage.uncovered_requirement_ids).toEqual([]);
  });

  it('deleting a requirement removes its references, records a tombstone, and recomputes coverage', () => {
    const doc = start();
    const next = ok(doc, { type: 'delete_requirement', id: 'r3' });
    expect(next.kit.role.requirements.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(q(next, 'q4').requirement_ids).toEqual(['r1']);
    expect(q(next, 'q3').requirement_ids).toEqual([]); // the question stays, now tests nothing
    expect(next.state.tombstones).toEqual([
      { kind: 'requirement', id: 'r3', match_key: 'stakeholder communication' },
    ]);
    expect(next.kit.coverage.uncovered_requirement_ids).toEqual([]);
    // the questions were changed by the cascade, not by the user
    expect(meta(next, 'questions', 'q4').edited).toBe(false);
    expect(validateKit(next.kit, { requestedDays: 3 }).ok).toBe(true);
  });

  it('deleting a manual requirement leaves no tombstone and its id is not reused', () => {
    let doc = ok(start(), {
      type: 'add_requirement',
      requirement: { text: 'Mine', kind: 'domain', priority: 'nice' },
    });
    doc = ok(doc, { type: 'delete_requirement', id: 'r4' });
    expect(doc.state.tombstones).toEqual([]);
    doc = ok(doc, {
      type: 'add_requirement',
      requirement: { text: 'Next', kind: 'domain', priority: 'nice' },
    });
    expect(doc.kit.role.requirements.at(-1)!.id).toBe('r5');
  });

  it('a manual deletion never blocks generated content with the same text', () => {
    let doc = ok(start(), {
      type: 'add_requirement',
      requirement: { text: 'Kafka', kind: 'domain', priority: 'nice' },
    });
    doc = ok(doc, { type: 'delete_requirement', id: 'r4' });
    expect(doc.state.tombstones.some((t) => t.match_key === 'kafka')).toBe(false);
  });

  it('reports a must-have gap, not a pretend cover, when its only question is deleted', () => {
    const doc = start();
    // r3 (must) is covered by q3 and q4: deleting one leaves it covered, deleting both opens the gap
    const one = ok(doc, { type: 'delete_question', id: 'q3' });
    expect(one.kit.coverage.uncovered_requirement_ids).toEqual([]);
    const both = ok(one, { type: 'delete_question', id: 'q4' });
    expect(both.kit.coverage.uncovered_requirement_ids).toEqual(['r3']);
    expect(
      checkCoverage(both.kit.role.requirements, both.kit.questions).uncovered_must_ids,
    ).toEqual(['r3']);
    expect(validateKit(both.kit, { requestedDays: 3 }).ok).toBe(true); // an honest gap is a valid kit
    // r1 loses q1 and q4 the same way
    const noR1 = ok(ok(doc, { type: 'delete_question', id: 'q1' }), {
      type: 'delete_question',
      id: 'q4',
    });
    expect(noR1.kit.coverage.uncovered_requirement_ids).toEqual(['r1']);
  });

  it('does not bring a deleted question back to fix a gap', () => {
    let doc = ok(start(), { type: 'delete_question', id: 'q2' });
    doc = ok(doc, { type: 'delete_question', id: 'q3' });
    doc = ok(doc, { type: 'edit_flashcard', id: 'f1', changes: { back: 'x' } });
    expect(doc.kit.questions.map((x) => x.id)).toEqual(['q1', 'q4']);
    expect(doc.kit.coverage.uncovered_requirement_ids).toEqual(['r2']);
  });

  it('keeps the recorded number of coverage passes', () => {
    const doc = ok(start(), { type: 'delete_question', id: 'q2' });
    expect(doc.kit.coverage.passes).toBe(2);
  });

  it('moving a question between days never changes coverage', () => {
    const doc = ok(start(), { type: 'move_question_to_day', question_id: 'q1', to_day: 3 });
    expect(doc.kit.coverage).toEqual(start().kit.coverage);
  });
});

describe('the schedule', () => {
  it('moves a question to the end of another day and recalculates both days', () => {
    const doc = start();
    const next = ok(doc, { type: 'move_question_to_day', question_id: 'q1', to_day: 3 });
    expect(day(next, 1).question_ids).toEqual(['q4']);
    expect(day(next, 3).question_ids).toEqual(['q2', 'q1']);
    expect(day(next, 1).minutes).toBe(15);
    expect(day(next, 3).minutes).toBe(30);
    expect(next.state.days.map((d) => d.edited)).toEqual([true, false, true]);
    expect(day(next, 2)).toEqual(day(doc, 2));
    expect(validateKit(next.kit, { requestedDays: 3 }).ok).toBe(true);
  });

  it('inserts at a position, including within the same day, and refuses a position past the end', () => {
    const doc = start();
    expect(
      day(ok(doc, { type: 'move_question_to_day', question_id: 'q2', to_day: 1, index: 1 }), 1)
        .question_ids,
    ).toEqual(['q1', 'q2', 'q4']);
    expect(
      day(ok(doc, { type: 'move_question_to_day', question_id: 'q4', to_day: 1, index: 0 }), 1)
        .question_ids,
    ).toEqual(['q4', 'q1']);
    expect(
      refused(doc, { type: 'move_question_to_day', question_id: 'q2', to_day: 1, index: 3 }).code,
    ).toBe('INDEX_OUT_OF_RANGE');
    expect(refused(doc, { type: 'move_question_to_day', question_id: 'q2', to_day: 9 }).code).toBe(
      'NOT_FOUND',
    );
    expect(refused(doc, { type: 'move_question_to_day', question_id: 'zzz', to_day: 1 }).code).toBe(
      'NOT_FOUND',
    );
  });

  it('moving a question to where it already is changes nothing, not even the edited flags', () => {
    const doc = start();
    expect(
      ok(doc, { type: 'move_question_to_day', question_id: 'q1', to_day: 1, index: 0 }),
    ).toEqual(doc);
  });

  it('every question stays scheduled exactly once after any move', () => {
    let doc = start();
    for (const [id, to] of [
      ['q1', 2],
      ['q2', 1],
      ['q3', 3],
      ['q4', 3],
      ['q1', 1],
    ] as const) {
      doc = ok(doc, { type: 'move_question_to_day', question_id: id, to_day: to });
      const scheduled = doc.kit.schedule.days.flatMap((d) => d.question_ids).sort();
      expect(scheduled).toEqual(['q1', 'q2', 'q3', 'q4']);
    }
  });

  it("edits a day focus, marks the day edited and the focus as the user's, and protects it afterwards", () => {
    let doc = ok(start(), { type: 'edit_day_focus', day: 1, focus: '  Warm-up  ' });
    expect(day(doc, 1).focus).toBe('Warm-up');
    expect(doc.state.days[0]).toEqual({
      day: 1,
      edited: true,
      pinned: false,
      focus_manual: true,
      minutes_manual: false,
    });
    doc = ok(doc, { type: 'move_question_to_day', question_id: 'q1', to_day: 2 });
    expect(day(doc, 1).focus).toBe('Warm-up'); // content changed, the user's words did not
    expect(day(doc, 1).minutes).toBe(15); // minutes were not set by the user, so they follow the content
    expect(refused(doc, { type: 'edit_day_focus', day: 1, focus: '  ' }).code).toBe(
      'INVALID_OPERATION',
    );
    expect(refused(doc, { type: 'edit_day_focus', day: 7, focus: 'x' }).code).toBe('NOT_FOUND');
  });

  it('sets day minutes by hand, keeps them when content changes, and returns to calculated on request', () => {
    let doc = ok(start(), { type: 'edit_day_minutes', day: 1, minutes: 90 });
    expect(day(doc, 1).minutes).toBe(90);
    expect(doc.state.days[0]).toMatchObject({ minutes_manual: true, edited: true });
    doc = ok(doc, { type: 'delete_question', id: 'q4' });
    expect(day(doc, 1).minutes).toBe(90);
    doc = ok(doc, { type: 'edit_day_minutes', day: 1, minutes: null });
    expect(day(doc, 1).minutes).toBe(20); // q1 alone: difficulty 3
    expect(doc.state.days[0]!.minutes_manual).toBe(false);
    expect(scheduleTotals(doc.kit)).toEqual({
      per_day: [
        { day: 1, minutes: 20 },
        { day: 2, minutes: 15 },
        { day: 3, minutes: 10 },
      ],
      total_minutes: 45,
    });
  });

  it("recalculates a day's minutes when a question's difficulty changes", () => {
    const next = ok(start(), { type: 'edit_question', id: 'q1', changes: { difficulty: 1 } });
    expect(day(next, 1).minutes).toBe(10 + 15);
  });

  it('a day left empty becomes a 30-minute review day, like the allocator makes them', () => {
    const doc = ok(start(), { type: 'delete_question', id: 'q2' });
    expect(day(doc, 3).question_ids).toEqual([]);
    expect(day(doc, 3).minutes).toBe(30);
    expect(day(doc, 3).focus).toBe(
      allocateSchedule({ days: 1, questions: [], requirements: [] }).days[0]!.focus,
    );
  });

  it('pins and unpins a day without changing it', () => {
    const doc = start();
    const pinned = ok(doc, { type: 'set_pin', target: { kind: 'day', day: 2 }, pinned: true });
    expect(pinned.state.days[1]).toMatchObject({ pinned: true, edited: false });
    expect(pinned.kit).toEqual(doc.kit);
    expect(ok(pinned, { type: 'set_pin', target: { kind: 'day', day: 2 }, pinned: false })).toEqual(
      doc,
    );
    expect(
      refused(doc, { type: 'set_pin', target: { kind: 'day', day: 5 }, pinned: true }).code,
    ).toBe('NOT_FOUND');
  });

  it('keeps the requested length and numbering through every operation', () => {
    let doc = start();
    const ops: BuilderOperation[] = [
      { type: 'delete_question', id: 'q1' },
      { type: 'move_question_to_day', question_id: 'q2', to_day: 1 },
      { type: 'edit_day_minutes', day: 2, minutes: 0 },
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
    ];
    for (const op of ops) {
      doc = ok(doc, op);
      expect(doc.kit.schedule.days_available).toBe(3);
      expect(doc.kit.schedule.days.map((d) => d.day)).toEqual([1, 2, 3]);
      expect(doc.state.requested_days).toBe(3);
    }
  });

  it('offers no way to add or remove a day', () => {
    const doc = start();
    expect(refused(doc, { type: 'add_day' }).code).toBe('INVALID_OPERATION');
    expect(refused(doc, { type: 'delete_day', day: 1 }).code).toBe('INVALID_OPERATION');
  });
});

describe('pinning other items', () => {
  it('pins and unpins flashcards and requirements, and refuses unknown targets', () => {
    let doc = start();
    doc = ok(doc, { type: 'set_pin', target: { kind: 'flashcard', id: 'f1' }, pinned: true });
    doc = ok(doc, { type: 'set_pin', target: { kind: 'requirement', id: 'r1' }, pinned: true });
    expect(meta(doc, 'flashcards', 'f1').pinned).toBe(true);
    expect(meta(doc, 'requirements', 'r1').pinned).toBe(true);
    expect(meta(doc, 'flashcards', 'f2').pinned).toBe(false);
    expect(
      refused(doc, { type: 'set_pin', target: { kind: 'flashcard', id: 'zz' }, pinned: true }).code,
    ).toBe('NOT_FOUND');
    expect(
      refused(doc, { type: 'set_pin', target: { kind: 'requirement', id: 'zz' }, pinned: true })
        .code,
    ).toBe('NOT_FOUND');
    expect(
      refused(doc, { type: 'set_pin', target: { kind: 'question', id: 'zz' }, pinned: true }).code,
    ).toBe('NOT_FOUND');
  });

  it('keeps pins, edited flags and provenance of unaffected items through unrelated operations', () => {
    let doc = start();
    doc = ok(doc, { type: 'set_pin', target: { kind: 'question', id: 'q1' }, pinned: true });
    doc = ok(doc, { type: 'edit_question', id: 'q3', changes: { prompt: 'x' } });
    doc = ok(doc, { type: 'delete_question', id: 'q2' });
    doc = ok(doc, {
      type: 'add_question',
      question: {
        prompt: 'm',
        answer_outline: '',
        difficulty: 1,
        category: 'technical',
        requirement_ids: [],
      },
    });
    expect(meta(doc, 'questions', 'q1')).toEqual({
      id: 'q1',
      origin: 'generated',
      edited: false,
      pinned: true,
    });
    expect(meta(doc, 'questions', 'q3')).toMatchObject({ edited: true });
    expect(meta(doc, 'questions', 'q4')).toEqual({
      id: 'q4',
      origin: 'generated',
      edited: false,
      pinned: false,
    });
  });
});

describe('invalid operations', () => {
  const BAD: [string, unknown][] = [
    ['not an object', 'delete_question'],
    ['null', null],
    ['an unknown type', { type: 'explode' }],
    ['a missing field', { type: 'delete_question' }],
    ['an empty change set', { type: 'edit_question', id: 'q1', changes: {} }],
    ['a difficulty out of range', { type: 'edit_question', id: 'q1', changes: { difficulty: 4 } }],
    ['a non-integer difficulty', { type: 'edit_question', id: 'q1', changes: { difficulty: 1.5 } }],
    ['an unknown category', { type: 'edit_question', id: 'q1', changes: { category: 'trivia' } }],
    ['a negative index', { type: 'move_question', id: 'q1', to_index: -1 }],
    ['fractional minutes', { type: 'edit_day_minutes', day: 1, minutes: 12.5 }],
    ['negative minutes', { type: 'edit_day_minutes', day: 1, minutes: -1 }],
    ['day zero', { type: 'edit_day_focus', day: 0, focus: 'x' }],
    [
      'a caller-supplied id on add',
      {
        type: 'add_question',
        id: 'q1',
        question: {
          prompt: 'p',
          answer_outline: '',
          difficulty: 1,
          category: 'technical',
          requirement_ids: [],
        },
        extra: 1,
      },
    ],
  ];

  it.each(BAD)(
    'refuses %s with INVALID_OPERATION or NOT_FOUND and changes nothing',
    (_name, op) => {
      const doc = start();
      const before = JSON.stringify(doc);
      const r = applyOperation(doc, op);
      if (r.ok) {
        // the only accepted case is the "extra property" one, which the schema strips and then allocates its own id
        expect(JSON.stringify(r.document.kit.questions.map((x) => x.id))).toBe(
          '["q1","q2","q3","q4","q5"]',
        );
      } else {
        expect(['INVALID_OPERATION', 'NOT_FOUND']).toContain(r.error.code);
      }
      expect(JSON.stringify(doc)).toBe(before);
    },
  );

  it('never lets a caller choose an id: the allocated one is used, so a duplicate cannot be created', () => {
    const doc = start();
    const next = ok(doc, {
      type: 'add_question',
      id: 'q1',
      question: {
        prompt: 'p',
        answer_outline: '',
        difficulty: 1,
        category: 'technical',
        requirement_ids: [],
      },
    });
    expect(next.kit.questions.map((x) => x.id)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5']);
    expect(q(next, 'q1')).toEqual(q(doc, 'q1'));
  });

  it('refusals leave the input document untouched and deeply equal', () => {
    const doc = start();
    const snapshot = clone(doc);
    refused(doc, { type: 'edit_question', id: 'q1', changes: { requirement_ids: ['nope'] } });
    refused(doc, { type: 'delete_question', id: 'nope' });
    expect(doc).toEqual(snapshot);
  });

  it('a successful operation does not mutate its input either', () => {
    const doc = start();
    const snapshot = clone(doc);
    ok(doc, { type: 'delete_requirement', id: 'r1' });
    ok(doc, { type: 'edit_brief', changes: { summary: 'x' } });
    expect(doc).toEqual(snapshot);
  });

  it('returns documents that share no objects with the input', () => {
    const doc = start();
    const next = ok(doc, { type: 'set_pin', target: { kind: 'brief' }, pinned: true });
    expect(next.kit).not.toBe(doc.kit);
    expect(next.kit.questions[0]).not.toBe(doc.kit.questions[0]);
    expect(next.state.questions[0]).not.toBe(doc.state.questions[0]);
  });
});

describe('sequences and determinism', () => {
  const SEQUENCE: BuilderOperation[] = [
    { type: 'edit_question', id: 'q1', changes: { prompt: 'Rewritten', difficulty: 2 } },
    { type: 'delete_question', id: 'q2' },
    {
      type: 'add_question',
      question: {
        prompt: 'Mine',
        answer_outline: 'o',
        difficulty: 3,
        category: 'system-design',
        requirement_ids: ['r1'],
      },
    },
    { type: 'move_question_to_day', question_id: 'q5', to_day: 1, index: 0 },
    { type: 'edit_requirement', id: 'r3', changes: { priority: 'nice' } },
    { type: 'delete_flashcard', id: 'f2' },
    { type: 'set_pin', target: { kind: 'day', day: 1 }, pinned: true },
    { type: 'edit_day_focus', day: 2, focus: 'Behavioural day' },
  ];

  it('applies operations one after another and ends in a valid, consistent document', () => {
    const result = applyOperations(start(), SEQUENCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { kit } = result.document;
    expect(validateKit(kit, { requestedDays: 3 }).ok).toBe(true);
    expect(checkBuilderDocument(result.document).ok).toBe(true);
    expect(kit.questions.map((x) => x.id)).toEqual(['q1', 'q3', 'q4', 'q5']);
    expect(kit.schedule.days[0]!.question_ids).toEqual(['q5', 'q1', 'q4']);
    expect(kit.coverage.uncovered_requirement_ids).toEqual(['r2']);
    expect(result.document.state.tombstones.map((t) => `${t.kind}:${t.id}`)).toEqual([
      'question:q2',
      'flashcard:f2',
    ]);
  });

  it('gives identical output for identical input, however many times it is run', () => {
    const a = applyOperations(start(), SEQUENCE);
    const b = applyOperations(start(), SEQUENCE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // one by one equals all at once
    let doc = start();
    for (const op of SEQUENCE) doc = ok(doc, op);
    expect(a.ok && JSON.stringify(a.document)).toBe(JSON.stringify(doc));
  });

  it('is all or nothing: a failure partway names the operation and applies none of it', () => {
    const doc = start();
    const before = clone(doc);
    const r = applyOperations(doc, [
      { type: 'delete_question', id: 'q1' },
      { type: 'delete_question', id: 'q1' }, // already gone
      { type: 'delete_question', id: 'q2' },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'NOT_FOUND', operation_index: 1 });
    expect(doc).toEqual(before);
  });

  it('an empty list of operations checks and returns the document', () => {
    const doc = start();
    const r = applyOperations(doc, []);
    expect(r.ok && r.document).toEqual(doc);
    const bad: BuilderDocument = { ...doc, state: { ...doc.state, questions: [] } };
    expect(applyOperations(bad, []).ok).toBe(false);
  });

  it('survives a round trip through JSON (what persistence will do)', () => {
    const result = applyOperations(start(), SEQUENCE);
    if (!result.ok) throw new Error('sequence refused');
    const stored = JSON.parse(JSON.stringify(result.document)) as BuilderDocument;
    expect(checkBuilderDocument(stored).ok).toBe(true);
    expect(applyOperation(stored, { type: 'delete_question', id: 'q5' }).ok).toBe(true);
  });
});

describe('what regeneration will need from this state', () => {
  it('can tell, from state alone, which items to keep: manual, edited and pinned', () => {
    let doc = start();
    doc = ok(doc, { type: 'edit_question', id: 'q1', changes: { prompt: 'edited' } });
    doc = ok(doc, { type: 'set_pin', target: { kind: 'question', id: 'q3' }, pinned: true });
    doc = ok(doc, {
      type: 'add_question',
      question: {
        prompt: 'm',
        answer_outline: '',
        difficulty: 1,
        category: 'technical',
        requirement_ids: [],
      },
    });
    const keep = doc.state.questions
      .filter((m) => m.origin === 'manual' || m.edited || m.pinned)
      .map((m) => m.id);
    expect(keep).toEqual(['q1', 'q3', 'q5']);
  });

  it('remembers what was deleted by id and by normalised text, so a re-worded duplicate can be recognised', () => {
    const doc = ok(start(), {
      type: 'edit_question',
      id: 'q1',
      changes: { prompt: 'Explain the   Event Loop' },
    });
    const next = ok(doc, { type: 'delete_question', id: 'q1' });
    const t = next.state.tombstones[0]!;
    expect(t).toEqual({ kind: 'question', id: 'q1', match_key: 'explain the event loop' });
    expect(matchKey('  EXPLAIN the event\tloop ', 'x')).toBe(t.match_key);
  });

  it('falls back to the id when an item has no text to compare', () => {
    expect(matchKey('   ', 'q9')).toBe('q9');
  });

  it('keeps the id counters ahead of everything ever deleted, so regenerated ids cannot collide', () => {
    let doc = start();
    for (const id of ['q4', 'q3']) doc = ok(doc, { type: 'delete_question', id });
    expect(doc.state.next_ids.question).toBe(5);
    expect(doc.state.tombstones.map((t) => t.id)).toEqual(['q4', 'q3']);
  });
});
