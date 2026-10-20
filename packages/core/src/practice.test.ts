import { describe, expect, it } from 'vitest';
import type { CardProgress } from '@trao/contracts';
import { orderForPractice, summarizePractice } from './practice';

const cards = ['f1', 'f2', 'f3', 'f4', 'f5'].map((id) => ({ id }));
const p = (
  card_id: string,
  confidence: 1 | 2 | 3,
  at = '2026-03-01T10:00:00.000Z',
): CardProgress => ({
  card_id,
  confidence,
  attempts: 1,
  last_practised_at: at,
});
const ids = (list: { id: string }[]) => list.map((c) => c.id);

describe('orderForPractice: the next session starts with what the user is least sure of', () => {
  it('keeps the kit order when nothing has been rated', () => {
    expect(ids(orderForPractice(cards, []))).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']);
  });

  it('puts cards never rated first, then lowest confidence to highest', () => {
    const progress = [p('f1', 3), p('f2', 1), p('f4', 2)]; // f3 and f5 never rated
    expect(ids(orderForPractice(cards, progress))).toEqual(['f3', 'f5', 'f2', 'f4', 'f1']);
  });

  it('uses the LATEST rating, so a card the user now knows moves to the back', () => {
    // f1 was 1, then rated 3: the progress holds the latest only
    expect(ids(orderForPractice(cards.slice(0, 2), [p('f1', 3), p('f2', 2)]))).toEqual([
      'f2',
      'f1',
    ]);
  });

  it('within one confidence level, the card practised longest ago comes first', () => {
    const progress = [
      p('f1', 2, '2026-03-03T10:00:00.000Z'),
      p('f2', 2, '2026-03-01T10:00:00.000Z'),
      p('f3', 2, '2026-03-02T10:00:00.000Z'),
    ];
    expect(ids(orderForPractice(cards.slice(0, 3), progress))).toEqual(['f2', 'f3', 'f1']);
  });

  it('breaks full ties by the kit order, so the result is stable and repeatable', () => {
    const progress = cards.map((c) => p(c.id, 2));
    expect(ids(orderForPractice(cards, progress))).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']);
    expect(ids(orderForPractice(cards, progress))).toEqual(ids(orderForPractice(cards, progress)));
  });

  it('includes every card exactly once, and ignores progress for cards that are not in the kit', () => {
    const progress = [p('ghost', 1), p('f1', 1)];
    const out = ids(orderForPractice(cards, progress));
    expect(out).toHaveLength(5);
    expect(new Set(out).size).toBe(5);
    expect(out).not.toContain('ghost');
  });

  it('treats an unreadable date as the oldest, and does not mutate its inputs', () => {
    const progress = [p('f1', 2, 'not a date'), p('f2', 2, '2026-03-01T10:00:00.000Z')];
    const before = JSON.stringify([cards, progress]);
    expect(ids(orderForPractice(cards.slice(0, 2), progress))).toEqual(['f1', 'f2']);
    expect(JSON.stringify([cards, progress])).toBe(before);
  });

  it('works for no cards at all', () => {
    expect(orderForPractice([], [p('f1', 1)])).toEqual([]);
  });

  it("returns the caller's own objects, so extra fields (front, back) survive", () => {
    const rich = [{ id: 'f1', front: 'Q', back: 'A' }];
    expect(orderForPractice(rich, [])[0]).toBe(rich[0]);
  });
});

describe('summarizePractice: what has been covered and what has not', () => {
  it('counts a card as covered once it has been rated, by its latest confidence', () => {
    const s = summarizePractice(cards, [p('f1', 3), p('f2', 1), p('f3', 1)]);
    expect(s).toEqual({
      total: 5,
      covered: 3,
      uncovered_ids: ['f4', 'f5'],
      by_confidence: { 1: 2, 2: 0, 3: 1 },
    });
  });

  it('with no progress, nothing is covered and everything is listed, in kit order', () => {
    expect(summarizePractice(cards, [])).toMatchObject({
      total: 5,
      covered: 0,
      uncovered_ids: ['f1', 'f2', 'f3', 'f4', 'f5'],
    });
  });

  it('covered plus uncovered always equals the total, even with progress for deleted cards', () => {
    const s = summarizePractice(cards, [p('ghost', 1), p('f1', 2)]);
    expect(s.covered + s.uncovered_ids.length).toBe(s.total);
    expect(s.by_confidence[1] + s.by_confidence[2] + s.by_confidence[3]).toBe(s.covered);
  });

  it('an empty kit has nothing to cover', () => {
    expect(summarizePractice([], [p('f1', 1)])).toEqual({
      total: 0,
      covered: 0,
      uncovered_ids: [],
      by_confidence: { 1: 0, 2: 0, 3: 0 },
    });
  });

  it('counts a repeated card id once', () => {
    expect(summarizePractice([{ id: 'f1' }, { id: 'f1' }], [p('f1', 2)])).toMatchObject({
      total: 1,
      covered: 1,
    });
  });
});
