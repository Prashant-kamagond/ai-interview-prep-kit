import { describe, expect, it } from 'vitest';
import {
  currentCard,
  sessionReducer,
  startSession,
  type SessionAction,
  type SessionCard,
  type SessionState,
} from './session';

const cards: SessionCard[] = [
  { id: 'f1', front: 'Q1', back: 'A1' },
  { id: 'f2', front: 'Q2', back: 'A2' },
  { id: 'f3', front: 'Q3', back: 'A3' },
];
const run = (actions: SessionAction[], from: SessionState = startSession(cards)) =>
  actions.reduce(sessionReducer, from);
const rate = (confidence: 1 | 2 | 3, attemptId = 'attempt-1'): SessionAction => ({
  type: 'rate',
  confidence,
  attemptId,
});

describe('starting', () => {
  it('begins on the first card with its answer hidden', () => {
    const s = startSession(cards);
    expect(s).toMatchObject({
      index: 0,
      revealed: false,
      status: 'asking',
      rated: [],
      skipped: [],
    });
    expect(currentCard(s)?.id).toBe('f1');
  });

  it('a session with no cards is already done', () => {
    expect(startSession([]).status).toBe('done');
    expect(currentCard(startSession([]))).toBeNull();
  });
});

describe('revealing', () => {
  it('shows the answer only after it is asked for', () => {
    expect(run([]).revealed).toBe(false);
    expect(run([{ type: 'reveal' }]).revealed).toBe(true);
  });

  it('cannot rate before the answer is revealed', () => {
    const s = run([rate(2)]);
    expect(s.status).toBe('asking');
    expect(s.pending).toBeNull();
    expect(s.rated).toEqual([]);
  });
});

describe('rating', () => {
  it('moves to saving with the chosen rating, and only a saved rating counts and advances', () => {
    const saving = run([{ type: 'reveal' }, rate(3, 'a-1')]);
    expect(saving).toMatchObject({
      status: 'saving',
      index: 0,
      pending: { confidence: 3, attemptId: 'a-1' },
    });
    expect(saving.rated).toEqual([]); // not yet recorded
    const next = sessionReducer(saving, { type: 'saved' });
    expect(next).toMatchObject({ index: 1, revealed: false, status: 'asking', pending: null });
    expect(next.rated).toEqual([{ cardId: 'f1', confidence: 3 }]);
  });

  it('ignores a second rating while one is being saved (no double submit)', () => {
    const saving = run([{ type: 'reveal' }, rate(1, 'a-1')]);
    expect(sessionReducer(saving, rate(3, 'a-2'))).toBe(saving);
    expect(sessionReducer(saving, { type: 'skip' })).toBe(saving);
    expect(sessionReducer(saving, { type: 'reveal' })).toBe(saving);
  });

  it('keeps the card, its answer and the choice when saving fails, and retries the SAME attempt', () => {
    const failed = run([
      { type: 'reveal' },
      rate(2, 'a-1'),
      { type: 'save-failed', message: 'down' },
    ]);
    expect(failed).toMatchObject({
      status: 'save-failed',
      index: 0,
      revealed: true,
      error: 'down',
      pending: { confidence: 2, attemptId: 'a-1' },
    });
    expect(failed.rated).toEqual([]);
    const retry = sessionReducer(failed, { type: 'retry' });
    expect(retry).toMatchObject({
      status: 'saving',
      pending: { attemptId: 'a-1', confidence: 2 },
      error: null,
    });
  });

  it('after a failure the user may choose a different rating, which is a new attempt', () => {
    const failed = run([{ type: 'reveal' }, rate(2, 'a-1'), { type: 'save-failed', message: 'x' }]);
    const other = sessionReducer(failed, rate(3, 'a-2'));
    expect(other).toMatchObject({ status: 'saving', pending: { confidence: 3, attemptId: 'a-2' } });
  });

  it('ignores saved and failed answers nobody is waiting for', () => {
    const s = run([]);
    expect(sessionReducer(s, { type: 'saved' })).toBe(s);
    expect(sessionReducer(s, { type: 'save-failed', message: 'x' })).toBe(s);
    expect(sessionReducer(s, { type: 'retry' })).toBe(s);
  });
});

describe('skipping and finishing', () => {
  it('skipping passes the card without recording anything', () => {
    const s = run([{ type: 'skip' }]);
    expect(s).toMatchObject({ index: 1, skipped: ['f1'], rated: [] });
  });

  it('cannot skip after the answer was shown (rate it instead)', () => {
    const s = run([{ type: 'reveal' }]);
    expect(sessionReducer(s, { type: 'skip' })).toBe(s);
  });

  it('is done after the last card, with every rating and skip accounted for', () => {
    const s = run([
      { type: 'reveal' },
      rate(1, 'a-1'),
      { type: 'saved' },
      { type: 'skip' },
      { type: 'reveal' },
      rate(3, 'a-3'),
      { type: 'saved' },
    ]);
    expect(s.status).toBe('done');
    expect(s.rated).toEqual([
      { cardId: 'f1', confidence: 1 },
      { cardId: 'f3', confidence: 3 },
    ]);
    expect(s.skipped).toEqual(['f2']);
    expect(s.rated.length + s.skipped.length).toBe(cards.length);
  });

  it('does nothing once done', () => {
    const done = run([{ type: 'skip' }, { type: 'skip' }, { type: 'skip' }]);
    expect(done.status).toBe('done');
    expect(sessionReducer(done, { type: 'reveal' })).toBe(done);
  });

  it('a one-card session finishes after that card', () => {
    const s = run([{ type: 'reveal' }, rate(2), { type: 'saved' }], startSession([cards[0]!]));
    expect(s.status).toBe('done');
  });
});
