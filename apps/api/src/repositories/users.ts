import { ObjectId } from 'mongodb';
import type { Collections } from '../db.js';
import type { UserDoc } from '../models.js';

export function userRepository(c: Collections) {
  return {
    /** Throws a duplicate-key error if the email exists; the unique index is the arbiter. */
    async create(email: string, passwordHash: string): Promise<UserDoc> {
      const doc: UserDoc = { _id: new ObjectId(), email, passwordHash, createdAt: new Date() };
      await c.users.insertOne(doc);
      return doc;
    },
    findByEmail(email: string): Promise<UserDoc | null> {
      return c.users.findOne({ email });
    },
    findById(id: ObjectId): Promise<UserDoc | null> {
      return c.users.findOne({ _id: id });
    },
  };
}
