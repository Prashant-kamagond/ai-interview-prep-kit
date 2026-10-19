import type { ObjectId } from 'mongodb';
import type { GenerationRequest } from '@trao/contracts';
import { GENERIC_ERROR_MESSAGE, notFound } from '../errors.js';
import { hashGenerationInput } from '../jobs/hash.js';
import { JobFailure, type JobRunner } from '../jobs/runner.js';
import type { Logger } from '../logger.js';
import type { JobDoc, JobError } from '../models.js';
import type { Repositories } from '../repositories/index.js';
import { parseObjectId } from './kits.js';

export interface JobView {
  id: string;
  status: JobDoc['status'];
  stage: string | null;
  progress: number | null;
  kit_id: string | null;
  error: JobError | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** The public shape of a job. The request payload, its hash and the owner are never exposed. */
export function toJobView(job: JobDoc): JobView {
  return {
    id: job._id.toHexString(),
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    kit_id: job.kitId?.toHexString() ?? null,
    error: job.error,
    created_at: job.createdAt.toISOString(),
    updated_at: job.updatedAt.toISOString(),
    started_at: job.startedAt?.toISOString() ?? null,
    finished_at: job.finishedAt?.toISOString() ?? null,
  };
}

/**
 * Generation jobs run in this process (no queue). The job document is the durable record of what
 * was requested and how it ended, but MongoDB cannot resume an interrupted in-process task: if the
 * server dies mid-run, `failInterrupted()` marks the orphan failed at the next startup and the
 * user must resubmit.
 */
export function createJobService(repos: Repositories, runner: JobRunner, logger: Logger) {
  const inFlight = new Set<Promise<void>>();

  async function fail(job: JobDoc, error: JobError): Promise<void> {
    await repos.jobs.transition(job._id, 'failed', { error });
  }

  async function execute(job: JobDoc): Promise<void> {
    const running = await repos.jobs.transition(job._id, 'running', {
      stage: 'starting',
      progress: 0,
    });
    if (!running) return; // already finished by someone else

    try {
      const { kitId } = await runner.run(
        { jobId: job._id.toHexString(), userId: job.userId.toHexString(), input: job.input },
        { report: (stage, progress) => repos.jobs.report(job._id, stage, progress) },
      );

      // Never claim success for a kit the owner does not have.
      const oid = parseObjectId(kitId);
      const kit = oid && (await repos.kits.findOwned(job.userId, oid));
      if (!kit) {
        logger.error(
          { jobId: job._id.toHexString() },
          'runner returned a kit the user does not own',
        );
        await fail(job, { code: 'INTERNAL_ERROR', message: GENERIC_ERROR_MESSAGE });
        return;
      }
      await repos.jobs.transition(job._id, 'succeeded', {
        kitId: kit._id,
        stage: 'done',
        progress: 100,
      });
    } catch (err) {
      if (err instanceof JobFailure) {
        await fail(job, { code: err.code, message: err.message });
      } else {
        // Unexpected errors may contain internals: log them, store only a generic message.
        logger.error({ err, jobId: job._id.toHexString() }, 'generation job crashed');
        await fail(job, { code: 'INTERNAL_ERROR', message: GENERIC_ERROR_MESSAGE });
      }
    }
  }

  function start(job: JobDoc): void {
    const task: Promise<void> = execute(job)
      .catch((err: unknown) => logger.error({ err }, 'could not record job outcome'))
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
  }

  return {
    async submit(
      userId: ObjectId,
      input: GenerationRequest,
    ): Promise<{ job: JobDoc; deduplicated: boolean }> {
      const { job, created } = await repos.jobs.insertActive({
        userId,
        inputHash: hashGenerationInput(input),
        input,
      });
      if (created) start(job);
      return { job, deduplicated: !created };
    },

    async get(userId: ObjectId, id: string): Promise<JobDoc> {
      const oid = parseObjectId(id);
      const job = oid && (await repos.jobs.findOwned(userId, oid));
      if (!job) throw notFound('Job');
      return job;
    },

    /** Startup sweep. Returns how many orphaned jobs were failed. */
    failInterrupted(): Promise<number> {
      return repos.jobs.failAllActive({
        code: 'SERVER_RESTARTED',
        message: 'The server restarted while this job was running. Please submit it again.',
      });
    },

    /** Resolves when every job started by this process has recorded its outcome. */
    async settled(): Promise<void> {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}

export type JobService = ReturnType<typeof createJobService>;
