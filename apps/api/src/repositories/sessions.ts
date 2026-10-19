import type { ObjectId } from 'mongodb';
import type { Collections } from '../db.js';
import type { SessionDoc } from '../models.js';

export function sessionRepository(c: Collections) {
  return {
    async create(tokenHash: string, userId: ObjectId, expiresAt: Date): Promise<void> {
      await c.sessions.insertOne({ _id: tokenHash, userId, createdAt: new Date(), expiresAt });
    },
    findByTokenHash(tokenHash: string): Promise<SessionDoc | null> {
      return c.sessions.findOne({ _id: tokenHash });
    },
    async deleteByTokenHash(tokenHash: string): Promise<void> {
      await c.sessions.deleteOne({ _id: tokenHash });
    },
  };
}
