import { ObjectId, MongoServerError } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import type { Collections } from '../db.js';
import type { PracticeCardDoc } from '../models.js';
import { practiceRepository } from './practice.js';

const userId = new ObjectId();
const kitId = new ObjectId();
const doc = (over: Partial<PracticeCardDoc> = {}): PracticeCardDoc => ({
  _id: new ObjectId(),
  userId,
  kitId,
  cardId: 'f1',
  confidence: 2,
  attempts: 1,
  lastAttemptId: 'attempt-one',
  lastPractisedAt: new Date(),
  ...over,
});
const duplicateKey = () => new MongoServerError({ code: 11000, message: 'E11000 duplicate key' });

function repoWith(collection: { findOneAndUpdate: unknown; findOne: unknown }) {
  return practiceRepository({ practice: collection } as unknown as Collections);
}

describe('recording a rating when two requests race to create the record', () => {
  it('retries a DIFFERENT attempt that lost the insert race, so its rating is not dropped', async () => {
    const winner = doc({ lastAttemptId: 'attempt-won' });
    const stored = doc({ lastAttemptId: 'attempt-lost', attempts: 2, confidence: 3 });
    const findOneAndUpdate = vi
      .fn()
      .mockRejectedValueOnce(duplicateKey()) // the unique index rejected our insert: someone else created it
      .mockResolvedValueOnce(stored); // second round: the record exists, our update applies
    const findOne = vi.fn().mockResolvedValue(winner);
    const out = await repoWith({ findOneAndUpdate, findOne }).record(
      userId,
      kitId,
      'f1',
      3,
      'attempt-lost',
    );
    expect(out).toEqual({ doc: stored, duplicate: false });
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('recognises a true repeat: the record that won carries this very attempt id', async () => {
    const winner = doc({ lastAttemptId: 'attempt-same' });
    const findOneAndUpdate = vi.fn().mockRejectedValue(duplicateKey());
    const findOne = vi.fn().mockResolvedValue(winner);
    const out = await repoWith({ findOneAndUpdate, findOne }).record(
      userId,
      kitId,
      'f1',
      2,
      'attempt-same',
    );
    expect(out).toEqual({ doc: winner, duplicate: true });
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('returns the stored record without a second round when the update applied', async () => {
    const stored = doc();
    const findOneAndUpdate = vi.fn().mockResolvedValue(stored);
    const out = await repoWith({ findOneAndUpdate, findOne: vi.fn() }).record(
      userId,
      kitId,
      'f1',
      2,
      'attempt-one',
    );
    expect(out).toEqual({ doc: stored, duplicate: false });
  });

  it('gives up with an error, never a silent drop, if it can never store the rating', async () => {
    const findOneAndUpdate = vi.fn().mockRejectedValue(duplicateKey());
    const findOne = vi.fn().mockResolvedValue(doc({ lastAttemptId: 'someone-else' }));
    await expect(
      repoWith({ findOneAndUpdate, findOne }).record(userId, kitId, 'f1', 2, 'attempt-x'),
    ).rejects.toThrow(/could not record/);
    expect(findOneAndUpdate.mock.calls.length).toBeGreaterThan(1);
  });

  it('does not swallow other database errors', async () => {
    const findOneAndUpdate = vi.fn().mockRejectedValue(new Error('connection lost'));
    await expect(
      repoWith({ findOneAndUpdate, findOne: vi.fn() }).record(userId, kitId, 'f1', 2, 'attempt-x'),
    ).rejects.toThrow('connection lost');
  });
});
