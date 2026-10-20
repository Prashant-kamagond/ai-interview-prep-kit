import { describe, expect, it } from 'vitest';
import type { BuilderOperation, Kit } from '@trao/contracts';
import {
  applyOperations,
  checkBuilderDocument,
  createBuilderDocument,
  type BuilderDocument,
} from './builder.js';
import { makeKit, question } from './fixtures.js';
import { initializeBuilderState, reconcileWholeKit } from './reconcile.js';

function start(): BuilderDocument {
  const r = createBuilderDocument(makeKit());
  if (!r.ok) throw new Error('fixture invalid');
  return r.document;
}
function built(ops: BuilderOperation[]): BuilderDocument {
  const r = applyOperations(start(), ops);
  if (!r.ok) throw new Error(`fixture operations refused: ${JSON.stringify(r.error)}`);
  return r.document;
}
function reconcile(doc: BuilderDocument, kit: Kit) {
  const r = reconcileWholeKit(doc, kit);
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r.document;
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const add = (prompt: string): BuilderOperation => ({
  type: 'add_question',
  question: {
    prompt,
    answer_outline: '',
    difficulty: 1,
    category: 'technical',
    requirement_ids: [],
  },
});

describe('reconcileWholeKit', () => {
  it('an identical kit changes nothing', () => {
    const doc = built([
      { type: 'set_pin', target: { kind: 'question', id: 'q1' }, pinned: true },
      add('m'),
    ]);
    expect(reconcile(doc, clone(doc.kit))).toEqual(doc);
  });

  it('marks a changed generated item edited, keeps its pin, and leaves unchanged items alone', () => {
    const doc = built([{ type: 'set_pin', target: { kind: 'question', id: 'q1' }, pinned: true }]);
    const kit = clone(doc.kit);
    kit.questions[0]!.prompt = 'Changed';
    kit.flashcards[0]!.back = 'Changed too';
    kit.role.requirements[1]!.text = 'Reworded';
    const next = reconcile(doc, kit);
    expect(next.state.questions.map((m) => [m.id, m.edited, m.pinned])).toEqual([
      ['q1', true, true],
      ['q2', false, false],
    ]);
    expect(next.state.flashcards[0]).toMatchObject({ edited: true });
    expect(next.state.requirements.map((m) => m.edited)).toEqual([false, true]);
  });

  it('never marks a manual item edited, however much it changes', () => {
    const doc = built([add('mine')]);
    const kit = clone(doc.kit);
    kit.questions.find((q) => q.id === 'q3')!.prompt = 'still mine';
    const next = reconcile(doc, kit);
    expect(next.state.questions.find((m) => m.id === 'q3')).toEqual({
      id: 'q3',
      origin: 'manual',
      edited: false,
      pinned: false,
    });
  });

  it('keeps an edited flag that is already set even if the item is saved unchanged', () => {
    const doc = built([{ type: 'edit_question', id: 'q1', changes: { prompt: 'x' } }]);
    expect(reconcile(doc, clone(doc.kit)).state.questions[0]!.edited).toBe(true);
  });

  it('treats an unknown id as manual and raises the counter above it', () => {
    const doc = start();
    const kit = clone(doc.kit);
    kit.questions.push(question('q40', ['r2']));
    kit.schedule.days[1]!.question_ids.push('q40');
    const next = reconcile(doc, kit);
    expect(next.state.questions.find((m) => m.id === 'q40')).toMatchObject({
      origin: 'manual',
      edited: false,
    });
    expect(next.state.next_ids.question).toBe(41);
  });

  it('records a removed generated item as a tombstone and a removed manual item as nothing', () => {
    const doc = built([add('mine')]);
    const kit = clone(doc.kit);
    kit.questions = kit.questions.filter((q) => q.id === 'q1');
    kit.schedule.days.forEach((d) => (d.question_ids = d.question_ids.filter((id) => id === 'q1')));
    kit.coverage.uncovered_requirement_ids = ['r2'];
    const next = reconcile(doc, kit);
    expect(next.state.tombstones).toEqual([{ kind: 'question', id: 'q2', match_key: 'prompt q2' }]);
    expect(next.state.questions.map((m) => m.id)).toEqual(['q1']);
  });

  it('removing a requirement tombstones it, and removing a flashcard tombstones it', () => {
    const doc = start();
    const kit = clone(doc.kit);
    kit.flashcards = [];
    kit.role.requirements = kit.role.requirements.filter((r) => r.id !== 'r2');
    kit.questions[1]!.requirement_ids = [];
    kit.coverage.uncovered_requirement_ids = [];
    const next = reconcile(doc, kit);
    expect(next.state.tombstones.map((t) => `${t.kind}:${t.id}`)).toEqual([
      'flashcard:f1',
      'requirement:r2',
    ]);
  });

  it('keeps every existing tombstone', () => {
    const doc = built([{ type: 'delete_question', id: 'q2' }]);
    const next = reconcile(doc, clone(doc.kit));
    expect(next.state.tombstones).toEqual(doc.state.tombstones);
  });

  it('refuses a kit that brings a deleted id back, for questions, flashcards and requirements', () => {
    const original = makeKit();
    const afterDelete = built([{ type: 'delete_question', id: 'q2' }]);
    const r1 = reconcileWholeKit(afterDelete, original);
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.error.code).toBe('TOMBSTONE_CONFLICT');
      expect(r1.error.message).toContain('question q2');
    }
    const noFlashcard = built([{ type: 'delete_flashcard', id: 'f1' }]);
    const r2 = reconcileWholeKit(noFlashcard, original);
    expect(!r2.ok && r2.error.code).toBe('TOMBSTONE_CONFLICT');
    const noReq = built([{ type: 'delete_requirement', id: 'r2' }]);
    const r3 = reconcileWholeKit(noReq, original);
    expect(!r3.ok && r3.error.code).toBe('TOMBSTONE_CONFLICT');
  });

  it('allows a re-worded replacement under a new id (the state only guards ids)', () => {
    const doc = built([{ type: 'delete_question', id: 'q2' }]);
    const kit = clone(doc.kit);
    kit.questions.push(question('q9', ['r2'], { prompt: 'Prompt q2' }));
    kit.schedule.days[1]!.question_ids.push('q9');
    kit.coverage.uncovered_requirement_ids = [];
    const next = reconcile(doc, kit);
    expect(next.state.questions.find((m) => m.id === 'q9')?.origin).toBe('manual');
    expect(next.state.tombstones).toHaveLength(1);
  });

  it('never lowers a counter, even when the highest items are gone', () => {
    const doc = built([add('a'), add('b')]); // q3, q4 handed out
    expect(doc.state.next_ids.question).toBe(5);
    const kit = clone(doc.kit);
    kit.questions = kit.questions.filter((q) => q.id === 'q1' || q.id === 'q2');
    kit.schedule.days.forEach(
      (d) => (d.question_ids = d.question_ids.filter((id) => id === 'q1' || id === 'q2')),
    );
    kit.schedule.days[0]!.minutes = 20;
    kit.schedule.days[1]!.minutes = 10;
    expect(reconcile(doc, kit).state.next_ids.question).toBe(5);
  });

  it('marks a changed brief edited and keeps its pin', () => {
    const doc = built([{ type: 'set_pin', target: { kind: 'brief' }, pinned: true }]);
    const kit = clone(doc.kit);
    kit.company_brief.summary = 'new';
    expect(reconcile(doc, kit).state.brief).toEqual({ edited: true, pinned: true });
  });

  it('keeps day pins and flags, and flags days whose content changed', () => {
    const doc = built([{ type: 'set_pin', target: { kind: 'day', day: 1 }, pinned: true }]);
    const kit = clone(doc.kit);
    kit.schedule.days[1]!.focus = 'My focus';
    kit.schedule.days[1]!.minutes = 99;
    const next = reconcile(doc, kit);
    expect(next.state.days[0]).toEqual(doc.state.days[0]);
    expect(next.state.days[1]).toMatchObject({
      edited: true,
      focus_manual: true,
      minutes_manual: true,
      pinned: false,
    });
  });

  it('follows a change in the number of days, dropping the pins of days that no longer exist', () => {
    const doc = built([{ type: 'set_pin', target: { kind: 'day', day: 2 }, pinned: true }]);
    const longer = clone(doc.kit);
    longer.schedule.days_available = 3;
    longer.schedule.days.push({ day: 3, focus: 'Review', question_ids: [], minutes: 30 });
    const grown = reconcile(doc, longer);
    expect(grown.state.requested_days).toBe(3);
    expect(grown.state.days.map((d) => [d.day, d.pinned, d.edited])).toEqual([
      [1, false, false],
      [2, true, false],
      [3, false, true],
    ]);

    const shorter = clone(doc.kit);
    shorter.schedule.days_available = 1;
    shorter.schedule.days = [{ day: 1, focus: 'All', question_ids: ['q1', 'q2'], minutes: 30 }];
    const shrunk = reconcile(doc, shorter);
    expect(shrunk.state.requested_days).toBe(1);
    expect(shrunk.state.days).toHaveLength(1);
  });

  it('refuses an invalid incoming kit with the validation issues', () => {
    const doc = start();
    const kit = clone(doc.kit);
    kit.coverage.uncovered_requirement_ids = ['r1'];
    const r = reconcileWholeKit(doc, kit);
    expect(!r.ok && r.error.code).toBe('KIT_INVALID');
    expect(reconcileWholeKit(doc, 'nonsense').ok).toBe(false);
  });

  it('refuses to reconcile into a state that is already inconsistent', () => {
    const doc = start();
    const bad: BuilderDocument = { ...doc, state: { ...doc.state, questions: [] } };
    const r = reconcileWholeKit(bad, doc.kit);
    expect(!r.ok && r.error.code).toBe('STATE_INCONSISTENT');
  });

  it('always yields a consistent document, does not mutate its inputs, and is deterministic', () => {
    const doc = built([add('mine'), { type: 'delete_question', id: 'q2' }]);
    const kit = clone(doc.kit);
    kit.questions[0]!.prompt = 'changed';
    const docBefore = JSON.stringify(doc);
    const kitBefore = JSON.stringify(kit);
    const a = reconcile(doc, kit);
    const b = reconcile(doc, kit);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(doc)).toBe(docBefore);
    expect(JSON.stringify(kit)).toBe(kitBefore);
    expect(checkBuilderDocument(a).ok).toBe(true);
  });
});

describe('initializeBuilderState', () => {
  it('is deterministic, so concurrent initialisations agree', () => {
    const a = initializeBuilderState(makeKit());
    const b = initializeBuilderState(makeKit());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(
      a.ok &&
        a.document.state.questions.every((m) => m.origin === 'generated' && !m.edited && !m.pinned),
    ).toBe(true);
  });

  it('refuses an invalid kit instead of guessing', () => {
    expect(initializeBuilderState({ nonsense: true }).ok).toBe(false);
  });
});
