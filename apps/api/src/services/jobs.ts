import type { ObjectId } from 'mongodb';
import type { GenerationRequest, RegenerationReport, RegenerationRequest } from '@trao/contracts';
import { AppError, GENERIC_ERROR_MESSAGE, notFound } from '../errors.js';
import { hashGenerationInput } from '../jobs/hash.js';
import type { RegenerationRunner } from '../jobs/regeneration-runner.js';
import { JobFailure, type JobRunner } from '../jobs/runner.js';
import type { Logger } from '../logger.js';
import type { JobDoc, JobError } from '../models.js';
import type { Repositories } from '../repositories/index.js';
import { parseObjectId } from './kits.js';

export interface JobView {
  id: string;
  /** What the job does: build a new kit, or regenerate a section of an existing one. */
  kind: 'generate' | 'regenerate';
  status: JobDoc['status'];
  stage: string | null;
  progress: number | null;
  kit_id: string | null;
  error: JobError | null;
  /** For a regeneration: what was kept, replaced, added and skipped. Null otherwise and until it finishes. */
  report: RegenerationReport | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** The public shape of a job. The request payload, its hash and the owner are never exposed. */
export function toJobView(job: JobDoc): JobView {
  return {
    id: job._id.toHexString(),
    kind: job.kind ?? 'generate',
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    kit_id: job.kitId?.toHexString() ?? null,
    error: job.error,
    report: job.report ?? null,
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
/**
 * Jobs run inside the API process, so how many may run at once is a resource limit, not a nicety: every
 * job crawls a site and calls a model. A user may have a few at a time (several roles prepared together),
 * and the server a bounded number overall. A request identical to one already running is never refused: it
 * joins that job. The check reads the count and then inserts, so a burst of simultaneous requests can
 * overshoot a limit by the size of the burst; it bounds the load, it is not a transaction.
 */
export interface JobServiceOptions {
  /**
   * Receives each job's task as it starts. A platform that ends a process once a response is sent passes
   * its "keep running until this settles" call here (Vercel's waitUntil). It is a request to the platform,
   * not a guarantee: the platform can still end the invocation, which is what `staleAfterMs` recovers from.
   */
  keepAlive?: (task: Promise<void>) => void;
  /**
   * When set, an active job that has not been updated for this long is failed with JOB_TIMED_OUT the next
   * time jobs are submitted or read. For platforms where an invocation can end without any shutdown hook
   * (so the startup sweep never runs). It must be longer than the longest invocation.
   */
  staleAfterMs?: number;
  /** Test seam for the clock. */
  now?: () => number;
}

export const STALE_JOB_ERROR = {
  code: 'JOB_TIMED_OUT',
  message:
    'This job stopped before it finished because the server ended it. Please submit it again.',
} as const;

export const MAX_ACTIVE_JOBS_PER_USER = 3;
export const MAX_ACTIVE_JOBS_TOTAL = 25;

export function createJobService(
  repos: Repositories,
  runner: JobRunner,
  logger: Logger,
  regenerationRunner?: RegenerationRunner,
  options: JobServiceOptions = {},
) {
  const inFlight = new Set<Promise<void>>();
  const now = options.now ?? Date.now;

  /** Fails jobs nobody is running any more. A no-op unless `staleAfterMs` is set. */
  async function recoverStale(): Promise<number> {
    if (options.staleAfterMs === undefined) return 0;
    return repos.jobs.failStale(new Date(now() - options.staleAfterMs), { ...STALE_JOB_ERROR });
  }

  async function fail(job: JobDoc, error: JobError): Promise<void> {
    await repos.jobs.transition(job._id, 'failed', { error });
  }

  /** A regeneration job: the runner changes the existing kit itself, or fails without changing it. */
  async function executeRegeneration(job: JobDoc): Promise<void> {
    const running = await repos.jobs.transition(job._id, 'running', {
      stage: 'starting',
      progress: 0,
    });
    if (!running) return;
    const regeneration = job.regeneration;
    try {
      if (!regenerationRunner || !regeneration) {
        throw new JobFailure(
          'REGENERATION_NOT_AVAILABLE',
          'Regeneration is not available on this server.',
        );
      }
      const out = await regenerationRunner.run(
        {
          jobId: job._id.toHexString(),
          userId: job.userId.toHexString(),
          kitId: regeneration.kitId.toHexString(),
          request: regeneration.request,
        },
        {
          report: (stage, progress) => repos.jobs.report(job._id, stage, progress),
          recordBaseVersion: (version) => repos.jobs.recordBaseVersion(job._id, version),
        },
      );
      const oid = parseObjectId(out.kitId);
      const kit = oid && (await repos.kits.findOwned(job.userId, oid));
      if (!kit) {
        logger.error(
          { jobId: job._id.toHexString() },
          'regeneration reported a kit the user does not own',
        );
        await fail(job, { code: 'INTERNAL_ERROR', message: GENERIC_ERROR_MESSAGE });
        return;
      }
      await repos.jobs.transition(job._id, 'succeeded', {
        kitId: kit._id,
        stage: 'done',
        progress: 100,
        report: out.report,
      });
    } catch (err) {
      if (err instanceof JobFailure) {
        await fail(job, { code: err.code, message: err.message });
      } else {
        logger.error({ err, jobId: job._id.toHexString() }, 'regeneration job crashed');
        await fail(job, { code: 'INTERNAL_ERROR', message: GENERIC_ERROR_MESSAGE });
      }
    }
  }

  async function execute(job: JobDoc): Promise<void> {
    if (job.kind === 'regenerate') return executeRegeneration(job);
    const running = await repos.jobs.transition(job._id, 'running', {
      stage: 'starting',
      progress: 0,
    });
    if (!running) return; // already finished by someone else

    try {
      if (!job.input) throw new JobFailure('INTERNAL_ERROR', GENERIC_ERROR_MESSAGE);
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
    try {
      options.keepAlive?.(task);
    } catch (err) {
      // Asking the platform for more time must never break the job itself.
      logger.warn({ err }, 'could not ask the platform to keep the job alive');
    }
  }

  async function checkCapacity(userId: ObjectId, inputHash: string): Promise<void> {
    if (await repos.jobs.findActive(userId, inputHash)) return; // it will join the running job
    if ((await repos.jobs.countActive(userId)) >= MAX_ACTIVE_JOBS_PER_USER) {
      throw new AppError(
        429,
        'TOO_MANY_ACTIVE_JOBS',
        `You already have ${MAX_ACTIVE_JOBS_PER_USER} jobs running. Wait for one to finish, then try again.`,
      );
    }
    if ((await repos.jobs.countActive()) >= MAX_ACTIVE_JOBS_TOTAL) {
      throw new AppError(
        503,
        'SERVER_BUSY',
        'The server is busy with other jobs right now. Please try again in a few minutes.',
      );
    }
  }

  return {
    async submit(
      userId: ObjectId,
      input: GenerationRequest,
    ): Promise<{ job: JobDoc; deduplicated: boolean }> {
      const inputHash = hashGenerationInput(input);
      await recoverStale();
      await checkCapacity(userId, inputHash);
      const { job, created } = await repos.jobs.insertActive({
        userId,
        inputHash,
        input,
      });
      if (created) start(job);
      return { job, deduplicated: !created };
    },

    /**
     * Starts a regeneration job. Identical requests that are still running share one job; the caller
     * has already checked ownership and sources. Nothing about the kit changes until the job's runner
     * writes its result.
     */
    async submitRegeneration(
      userId: ObjectId,
      regeneration: { kitId: ObjectId; request: RegenerationRequest },
      inputHash: string,
    ): Promise<{ job: JobDoc; deduplicated: boolean }> {
      await recoverStale();
      await checkCapacity(userId, inputHash);
      const { job, created } = await repos.jobs.insertActive({ userId, inputHash, regeneration });
      if (created) start(job);
      return { job, deduplicated: !created };
    },

    async get(userId: ObjectId, id: string): Promise<JobDoc> {
      const oid = parseObjectId(id);
      let job = oid && (await repos.jobs.findOwned(userId, oid));
      if (!job) throw notFound('Job');
      // Only a job that looks abandoned pays for the sweep.
      if (
        job.active &&
        options.staleAfterMs !== undefined &&
        job.updatedAt.getTime() < now() - options.staleAfterMs
      ) {
        await recoverStale();
        job = (oid && (await repos.jobs.findOwned(userId, oid))) || job;
      }
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
