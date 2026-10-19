import { ObjectId } from 'mongodb';
import type { GenerationRequest, JobStatus } from '@trao/contracts';
import { isDuplicateKeyError, type Collections } from '../db.js';
import { allowedSources, isTerminal } from '../jobs/state.js';
import type { JobDoc, JobError } from '../models.js';

export interface NewJob {
  userId: ObjectId;
  inputHash: string;
  input: GenerationRequest;
}

export interface JobPatch {
  stage?: string | null;
  progress?: number | null;
  kitId?: ObjectId | null;
  error?: JobError | null;
}

const MAX_INSERT_ATTEMPTS = 3;

export function jobRepository(c: Collections) {
  return {
    /**
     * Inserts a queued job, or returns the existing active job for the same user and input.
     * The partial unique index arbitrates races: of N simultaneous identical requests exactly one
     * insert succeeds and the others receive a duplicate-key error and read the winner back.
     */
    async insertActive(newJob: NewJob): Promise<{ job: JobDoc; created: boolean }> {
      for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS; attempt++) {
        const now = new Date();
        const job: JobDoc = {
          _id: new ObjectId(),
          userId: newJob.userId,
          status: 'queued',
          active: true,
          inputHash: newJob.inputHash,
          input: newJob.input,
          stage: null,
          progress: null,
          kitId: null,
          error: null,
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          finishedAt: null,
        };
        try {
          await c.jobs.insertOne(job);
          return { job, created: true };
        } catch (err) {
          if (!isDuplicateKeyError(err)) throw err;
          const existing = await c.jobs.findOne({
            userId: newJob.userId,
            inputHash: newJob.inputHash,
            active: true,
          });
          if (existing) return { job: existing, created: false };
          // The earlier job finished between our insert and our read: try the insert again.
        }
      }
      throw new Error('Could not create or find an active job after repeated attempts');
    },

    findOwned(userId: ObjectId, id: ObjectId): Promise<JobDoc | null> {
      return c.jobs.findOne({ _id: id, userId });
    },

    /**
     * Atomically moves a job to `to`, only if it is currently in a state from which that
     * transition is legal. Returns null (and changes nothing) otherwise.
     */
    async transition(id: ObjectId, to: JobStatus, patch: JobPatch = {}): Promise<JobDoc | null> {
      const from = allowedSources(to);
      if (from.length === 0) return null;
      const now = new Date();
      const set: Partial<JobDoc> = { ...patch, status: to, updatedAt: now };
      if (to === 'running') set.startedAt = now;
      if (isTerminal(to)) {
        set.active = false;
        set.finishedAt = now;
      }
      return c.jobs.findOneAndUpdate(
        { _id: id, status: { $in: from } },
        { $set: set },
        { returnDocument: 'after' },
      );
    },

    async report(id: ObjectId, stage: string, progress: number): Promise<void> {
      await c.jobs.updateOne(
        { _id: id, status: 'running' },
        { $set: { stage, progress, updatedAt: new Date() } },
      );
    },

    /** Fails every job still marked active. Only valid at startup of a single-instance server. */
    async failAllActive(error: JobError): Promise<number> {
      const now = new Date();
      const res = await c.jobs.updateMany(
        { active: true },
        { $set: { status: 'failed', active: false, error, finishedAt: now, updatedAt: now } },
      );
      return res.modifiedCount;
    },
  };
}
