import { ObjectId } from 'mongodb';
import type { RegenerationReport, RegenerationRequest } from '@trao/contracts';
import { applyRegeneration } from '@trao/core';
import {
  CaseFailure,
  RegenerationRefusal,
  checkRegenerationSources,
  failureFromGeneration,
  generateRegeneration,
  systemClock,
  type RunCaseDeps,
} from '@trao/pipeline';
import type { Logger } from '../logger.js';
import type { Repositories } from '../repositories/index.js';
import { researchOf } from '../services/builder-support.js';
import type { BuilderService } from '../services/builder.js';
import { resolveCreateLlm } from './llm.js';
import { JobFailure } from './runner.js';

export interface RegenerationRunInput {
  jobId: string;
  userId: string;
  kitId: string;
  request: RegenerationRequest;
}

export interface RegenerationRunnerContext {
  report(stage: string, progress: number): Promise<void>;
  /** Records the kit version this run started from. */
  recordBaseVersion(version: number): Promise<void>;
}

export interface RegenerationRunner {
  run(
    job: RegenerationRunInput,
    ctx: RegenerationRunnerContext,
  ): Promise<{ kitId: string; report: RegenerationReport }>;
}

export const DEFAULT_REGENERATION_DEADLINE_MS = 90_000;

export interface RegenerationRunnerOptions {
  repos: Pick<Repositories, 'kits'>;
  builder: Pick<BuilderService, 'load'>;
  logger: Logger;
  /** Replaces the real model client. Tests use a fake; production reads the LLM_* variables. */
  createLlm?: RunCaseDeps['createLlm'];
  env?: NodeJS.ProcessEnv;
  deadlineMs?: number;
}

/**
 * The regeneration job. It reads the kit and its builder state once, remembers the version it read,
 * generates the requested section from the kit's stored evidence, merges it with the pure
 * `applyRegeneration`, and writes kit and state together ONLY if the kit is still at that version.
 * If anything fails, or the kit changed while this ran, nothing is written: a failed or conflicting
 * regeneration leaves the kit exactly as it was.
 */
export function createRegenerationRunner(options: RegenerationRunnerOptions): RegenerationRunner {
  return {
    async run(job, ctx) {
      const userId = new ObjectId(job.userId);
      await ctx.report('loading', 5);
      const loaded = await options.builder.load(userId, job.kitId).catch((err: unknown) => {
        if ((err as { status?: number }).status === 404) {
          throw new JobFailure('KIT_NOT_FOUND', 'The kit no longer exists in your account.');
        }
        throw err;
      });
      const { oid, doc, builder } = loaded;
      await ctx.recordBaseVersion(doc.version);

      const research = researchOf(doc);
      const sources = checkRegenerationSources(job.request, doc.kit, research);
      if (!sources.ok) throw new JobFailure(sources.code, sources.message);

      let payload;
      if (job.request.section === 'schedule') {
        payload = { section: 'schedule' as const };
      } else {
        await ctx.report('generating', 30);
        const createLlm = resolveCreateLlm(options);
        const clock = systemClock;
        const deadline = clock.now() + (options.deadlineMs ?? DEFAULT_REGENERATION_DEADLINE_MS);
        try {
          payload = await generateRegeneration(job.request, doc.kit, research, {
            llm: createLlm({ deadline, clock }),
          });
        } catch (err) {
          if (err instanceof RegenerationRefusal) throw new JobFailure(err.code, err.message);
          const failure = failureFromGeneration(err);
          if (failure.code !== 'INTERNAL_ERROR')
            throw new JobFailure(failure.code, failure.message);
          throw err instanceof CaseFailure ? (failure.cause ?? err) : err;
        }
      }

      await ctx.report('applying', 90);
      const merged = applyRegeneration({ kit: doc.kit, state: builder }, payload);
      if (!merged.ok) {
        options.logger.warn({ jobId: job.jobId, error: merged.error }, 'regeneration was rejected');
        throw new JobFailure(
          'REGENERATION_REJECTED',
          'The regenerated material could not be merged into the kit, so nothing was changed.',
        );
      }

      const unchanged =
        JSON.stringify(merged.document.kit) === JSON.stringify(doc.kit) &&
        JSON.stringify(merged.document.state) === JSON.stringify(builder);
      if (!unchanged) {
        const updated = await options.repos.kits.replaceDocumentIfVersion(
          userId,
          oid,
          doc.version,
          merged.document.kit,
          merged.document.state,
        );
        if (!updated) {
          throw new JobFailure(
            'VERSION_CONFLICT',
            'The kit was changed while this was running. Nothing was applied. Review the current kit and run it again.',
          );
        }
      }
      return { kitId: job.kitId, report: merged.report };
    },
  };
}
