import { MongoClient, MongoServerError, type Collection, type Db } from 'mongodb';
import type { JobDoc, KitDoc, PracticeCardDoc, SessionDoc, UserDoc } from './models.js';

export const COLLECTIONS = {
  users: 'users',
  sessions: 'sessions',
  kits: 'kits',
  jobs: 'generation_jobs',
  practice: 'practice_cards',
} as const;

export interface Collections {
  users: Collection<UserDoc>;
  sessions: Collection<SessionDoc>;
  kits: Collection<KitDoc>;
  jobs: Collection<JobDoc>;
  practice: Collection<PracticeCardDoc>;
}

export function collections(db: Db): Collections {
  return {
    users: db.collection<UserDoc>(COLLECTIONS.users),
    sessions: db.collection<SessionDoc>(COLLECTIONS.sessions),
    kits: db.collection<KitDoc>(COLLECTIONS.kits),
    jobs: db.collection<JobDoc>(COLLECTIONS.jobs),
    practice: db.collection<PracticeCardDoc>(COLLECTIONS.practice),
  };
}

export async function connectMongo(uri: string): Promise<MongoClient> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  return client;
}

export function isDuplicateKeyError(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

/**
 * Indexes follow the access patterns, and the uniqueness rules are enforced here so concurrent
 * requests cannot race past an application-level check. Idempotent.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  const c = collections(db);

  // Registration: unique email, enforced atomically.
  await c.users.createIndex({ email: 1 }, { unique: true, name: 'email_unique' });

  // Session cookies are looked up by _id (the hashed token). The TTL index removes expired
  // records; its monitor runs about once a minute, so the code also checks expiresAt itself.
  await c.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'expiresAt_ttl' });
  await c.sessions.createIndex({ userId: 1 }, { name: 'userId' });

  // "My kits, most recently edited first" — every kit query is scoped by owner.
  await c.kits.createIndex({ userId: 1, updatedAt: -1 }, { name: 'userId_updatedAt' });

  // At most one queued/running job per user and input. Terminal jobs have active=false and fall
  // out of the index, so the same request can be made again once the previous job finished.
  await c.jobs.createIndex(
    { userId: 1, inputHash: 1 },
    {
      unique: true,
      partialFilterExpression: { active: true },
      name: 'active_job_per_input_unique',
    },
  );
  await c.jobs.createIndex({ userId: 1, createdAt: -1 }, { name: 'userId_createdAt' });

  // Practice: one record per (user, kit, card). The unique index is what makes recording a rating atomic
  // and lets a repeated request be recognised instead of double counted.
  await c.practice.createIndex(
    { userId: 1, kitId: 1, cardId: 1 },
    { unique: true, name: 'practice_card_unique' },
  );
  // Startup sweep for jobs a previous process left active.
  await c.jobs.createIndex(
    { createdAt: 1 },
    { partialFilterExpression: { active: true }, name: 'active_jobs' },
  );
}
