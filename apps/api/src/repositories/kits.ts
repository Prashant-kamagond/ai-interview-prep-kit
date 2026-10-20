import { ObjectId } from 'mongodb';
import type { BuilderState, Kit, ResearchSnapshot } from '@trao/contracts';
import type { Collections } from '../db.js';
import type { KitDoc } from '../models.js';

export type KitSummaryDoc = Pick<KitDoc, '_id' | 'version' | 'createdAt' | 'updatedAt'> & {
  kit: { source: Pick<Kit['source'], 'company' | 'role'> };
};

/** Every method takes the owner's id and filters on it: ownership is part of the query itself. */
export function kitRepository(c: Collections) {
  return {
    async insert(
      userId: ObjectId,
      kit: Kit,
      extras: { builder?: BuilderState; research?: ResearchSnapshot } = {},
    ): Promise<KitDoc> {
      const now = new Date();
      const doc: KitDoc = {
        _id: new ObjectId(),
        userId,
        kit,
        ...(extras.builder ? { builder: extras.builder } : {}),
        ...(extras.research ? { research: extras.research } : {}),
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      await c.kits.insertOne(doc);
      return doc;
    },

    listSummaries(userId: ObjectId): Promise<KitSummaryDoc[]> {
      return c.kits
        .find<KitSummaryDoc>(
          { userId },
          {
            projection: {
              version: 1,
              createdAt: 1,
              updatedAt: 1,
              'kit.source.company': 1,
              'kit.source.role': 1,
            },
          },
        )
        .sort({ updatedAt: -1, _id: -1 })
        .toArray();
    },

    findOwned(userId: ObjectId, id: ObjectId): Promise<KitDoc | null> {
      return c.kits.findOne({ _id: id, userId });
    },

    /**
     * Replaces the kit only if it is still at `expectedVersion`. The version is part of the
     * filter, so the check and the write are one atomic operation: of several writers starting
     * from the same version, exactly one matches. Returns null when nothing matched (the caller
     * then distinguishes "stale" from "not found").
     */
    replaceIfVersion(
      userId: ObjectId,
      id: ObjectId,
      expectedVersion: number,
      kit: Kit,
    ): Promise<KitDoc | null> {
      return c.kits.findOneAndUpdate(
        { _id: id, userId, version: expectedVersion },
        { $set: { kit, updatedAt: new Date() }, $inc: { version: 1 } },
        { returnDocument: 'after' },
      );
    },

    /**
     * Stores builder state on a kit that has none. The filter requires the kit to still be at
     * `version` with no state, so of several requests that initialise the same kit at once exactly one
     * writes, and a kit changed in the meantime is left for the caller to read again. The version is
     * not incremented: initialising metadata is not a change to the kit.
     */
    async initBuilderIfMissing(
      userId: ObjectId,
      id: ObjectId,
      version: number,
      builder: BuilderState,
    ): Promise<boolean> {
      const res = await c.kits.updateOne(
        { _id: id, userId, version, builder: { $exists: false } },
        { $set: { builder } },
      );
      return res.modifiedCount === 1;
    },

    /**
     * Replaces the kit and its builder state in ONE document update, only if the kit is still at
     * `expectedVersion`. MongoDB applies a single-document update atomically, so the kit, the state and
     * the new version are all written or none are, and of several writers from the same version exactly
     * one matches. Research is deliberately not touched. Null means nothing matched.
     */
    replaceDocumentIfVersion(
      userId: ObjectId,
      id: ObjectId,
      expectedVersion: number,
      kit: Kit,
      builder: BuilderState,
    ): Promise<KitDoc | null> {
      return c.kits.findOneAndUpdate(
        { _id: id, userId, version: expectedVersion },
        { $set: { kit, builder, updatedAt: new Date() }, $inc: { version: 1 } },
        { returnDocument: 'after' },
      );
    },

    async deleteOwned(userId: ObjectId, id: ObjectId): Promise<boolean> {
      const res = await c.kits.deleteOne({ _id: id, userId });
      return res.deletedCount === 1;
    },
  };
}
