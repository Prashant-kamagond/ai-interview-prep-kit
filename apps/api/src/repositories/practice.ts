import type { ObjectId } from 'mongodb';
import { isDuplicateKeyError, type Collections } from '../db.js';
import type { PracticeCardDoc } from '../models.js';

const MAX_ROUNDS = 5;

/** Every method filters on the owner and the kit: there is no way to reach another user's progress. */
export function practiceRepository(c: Collections) {
  return {
    listForKit(userId: ObjectId, kitId: ObjectId): Promise<PracticeCardDoc[]> {
      return c.practice.find({ userId, kitId }).sort({ cardId: 1 }).toArray();
    },

    /**
     * Records a rating, once per `attemptId`. The filter only matches a record whose latest attempt
     * is a different one, so a repeated request matches nothing; if no record exists at all the upsert
     * inserts one, and if the repeat matched nothing because it IS the latest attempt, the unique index
     * rejects the insert and the call reports "already recorded". Returns the stored record either way.
     */
    async record(
      userId: ObjectId,
      kitId: ObjectId,
      cardId: string,
      confidence: 1 | 2 | 3,
      attemptId: string,
    ): Promise<{ doc: PracticeCardDoc; duplicate: boolean }> {
      // Two requests that are the FIRST rating of a card can both reach the insert at once. The unique
      // index lets one in and rejects the other; that other request is only a repeat if the record that won
      // carries ITS attempt id. Otherwise it is a different rating that must still be counted, so it is
      // tried again, now against a record that exists. A few rounds always suffice: each round some
      // request's rating is stored.
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const now = new Date();
        try {
          const doc = await c.practice.findOneAndUpdate(
            { userId, kitId, cardId, lastAttemptId: { $ne: attemptId } },
            {
              $set: { confidence, lastAttemptId: attemptId, lastPractisedAt: now },
              $inc: { attempts: 1 },
              $setOnInsert: { userId, kitId, cardId },
            },
            { upsert: true, returnDocument: 'after' },
          );
          if (doc) return { doc, duplicate: false };
        } catch (err) {
          if (!isDuplicateKeyError(err)) throw err;
        }
        const existing = await c.practice.findOne({ userId, kitId, cardId });
        if (existing?.lastAttemptId === attemptId) return { doc: existing, duplicate: true };
        // no record yet, or its latest attempt is someone else's: our rating has not been stored
      }
      throw new Error('could not record the practice rating after repeated attempts');
    },

    async deleteForKit(userId: ObjectId, kitId: ObjectId): Promise<number> {
      return (await c.practice.deleteMany({ userId, kitId })).deletedCount;
    },
  };
}
