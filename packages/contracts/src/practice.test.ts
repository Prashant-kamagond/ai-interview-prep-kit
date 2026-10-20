import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_LEVELS,
  cardProgressSchema,
  confidenceSchema,
  practiceAttemptRequestSchema,
  practiceProgressResponseSchema,
} from './index';

describe('practice contracts', () => {
  it('has exactly three confidence levels, 1 (least) to 3 (most)', () => {
    expect([...CONFIDENCE_LEVELS]).toEqual([1, 2, 3]);
    for (const ok of [1, 2, 3]) expect(confidenceSchema.safeParse(ok).success).toBe(true);
    for (const bad of [0, 4, 1.5, '2', null, undefined, -1])
      expect(confidenceSchema.safeParse(bad).success).toBe(false);
  });

  it('a rating needs a valid confidence and a well-formed attempt id', () => {
    expect(
      practiceAttemptRequestSchema.safeParse({ confidence: 2, attempt_id: 'abcd1234' }).success,
    ).toBe(true);
    expect(
      practiceAttemptRequestSchema.safeParse({
        confidence: 3,
        attempt_id: '3f2b8c1e-8d4a-4f6e-9a1b-0c5d7e9f1a2b',
      }).success,
    ).toBe(true);
    for (const bad of [
      {},
      { confidence: 2 },
      { attempt_id: 'abcd1234' },
      { confidence: 5, attempt_id: 'abcd1234' },
      { confidence: 2, attempt_id: 'short' },
      { confidence: 2, attempt_id: 'x'.repeat(65) },
      { confidence: 2, attempt_id: 'has space in it' },
      { confidence: 2, attempt_id: '../../etc/passwd' },
      { confidence: 2, attempt_id: { $ne: 'x' } },
    ]) {
      expect(practiceAttemptRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('card progress and the progress response are validated', () => {
    const card = {
      card_id: 'f1',
      confidence: 2,
      attempts: 3,
      last_practised_at: '2026-03-01T10:00:00.000Z',
    };
    expect(cardProgressSchema.safeParse(card).success).toBe(true);
    expect(cardProgressSchema.safeParse({ ...card, attempts: 0 }).success).toBe(false);
    expect(cardProgressSchema.safeParse({ ...card, confidence: 4 }).success).toBe(false);
    expect(practiceProgressResponseSchema.safeParse({ kit_id: 'k', cards: [card] }).success).toBe(
      true,
    );
    expect(practiceProgressResponseSchema.safeParse({ kit_id: 'k', cards: [] }).success).toBe(true);
    expect(practiceProgressResponseSchema.safeParse({ kit_id: '', cards: [] }).success).toBe(false);
    expect(practiceProgressResponseSchema.safeParse({ kit_id: 'k' }).success).toBe(false);
  });
});
