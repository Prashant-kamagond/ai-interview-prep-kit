import type { ObjectId } from 'mongodb';
import {
  practiceProgressResponseSchema,
  type CardProgress,
  type PracticeAttemptRequest,
  type PracticeProgressResponse,
} from '@trao/contracts';
import { AppError, GENERIC_ERROR_MESSAGE, notFound } from '../errors.js';
import type { PracticeCardDoc } from '../models.js';
import type { Repositories } from '../repositories/index.js';
import { parseObjectId } from './kits.js';

const view = (doc: PracticeCardDoc): CardProgress => ({
  card_id: doc.cardId,
  confidence: doc.confidence,
  attempts: doc.attempts,
  last_practised_at: doc.lastPractisedAt.toISOString(),
});

export function createPracticeService(repos: Pick<Repositories, 'kits' | 'practice'>) {
  /** The kit, as its owner. A missing kit and someone else's kit are the same 404. */
  async function ownedKit(userId: ObjectId, id: string) {
    const oid = parseObjectId(id);
    const doc = oid && (await repos.kits.findOwned(userId, oid));
    if (!oid || !doc) throw notFound('Kit');
    return { oid, doc };
  }

  return {
    /** The user's progress for this kit, limited to cards the kit still has. */
    async progress(userId: ObjectId, id: string): Promise<PracticeProgressResponse> {
      const { oid, doc } = await ownedKit(userId, id);
      const present = new Set(doc.kit.flashcards.map((f) => f.id));
      const cards = (await repos.practice.listForKit(userId, oid))
        .filter((p) => present.has(p.cardId))
        .map(view);
      const parsed = practiceProgressResponseSchema.safeParse({ kit_id: oid.toHexString(), cards });
      if (!parsed.success) throw new AppError(500, 'INTERNAL_ERROR', GENERIC_ERROR_MESSAGE);
      return parsed.data;
    },

    /**
     * Records one rating. The card must be in the kit. A repeat of the same `attempt_id` (a retry, a
     * double click) changes nothing and answers with the stored record.
     */
    async record(
      userId: ObjectId,
      id: string,
      cardId: string,
      body: PracticeAttemptRequest,
    ): Promise<{ progress: CardProgress; duplicate: boolean }> {
      const { oid, doc } = await ownedKit(userId, id);
      if (!doc.kit.flashcards.some((f) => f.id === cardId)) throw notFound('Flashcard');
      const { doc: stored, duplicate } = await repos.practice.record(
        userId,
        oid,
        cardId,
        body.confidence,
        body.attempt_id,
      );
      return { progress: view(stored), duplicate };
    },

    /** Forgets all progress for this kit (the user starts over). */
    async reset(userId: ObjectId, id: string): Promise<void> {
      const { oid } = await ownedKit(userId, id);
      await repos.practice.deleteForKit(userId, oid);
    },
  };
}

export type PracticeService = ReturnType<typeof createPracticeService>;
