import { ObjectId } from 'mongodb';
import {
  CaseFailure,
  LlmError,
  createLlmClientFromConfig,
  loadLlmConfig,
  runCase,
  type RunCaseDeps,
} from '@trao/pipeline';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { Repositories } from '../repositories/index.js';
import { JobFailure, type JobRunner } from './runner.js';

export interface PipelineRunnerOptions {
  repos: Pick<Repositories, 'kits'>;
  config: Pick<Config, 'allowPrivateHosts' | 'nodeEnv'>;
  logger: Logger;
  /** Replaces the real model client. Tests use a fake; production reads the LLM_* variables. */
  createLlm?: RunCaseDeps['createLlm'];
  /** Research overrides (tests: no discussion lookup, no politeness delay). */
  research?: RunCaseDeps['research'];
  /** Where the LLM_* variables are read from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** The per-job time budget. Defaults to runCase's own (90 seconds). */
  caseDeadlineMs?: number;
}

/**
 * The real generation job: the same runCase the batch command uses, then the kit is stored for the
 * job's owner. Everything a user can see on failure is a stable code and a curated message; anything
 * unexpected is rethrown so the job service logs it and stores only the generic message.
 *
 * The model settings are read when a job runs, not when the server starts, so a server without a key
 * still serves everything else and fails generation jobs with LLM_NOT_CONFIGURED.
 */
export function createPipelineRunner(options: PipelineRunnerOptions): JobRunner {
  const env = options.env ?? process.env;

  function resolveCreateLlm(): RunCaseDeps['createLlm'] {
    if (options.createLlm) return options.createLlm;
    try {
      const config = loadLlmConfig(env);
      return ({ deadline, clock }) => createLlmClientFromConfig(config, { deadline, clock });
    } catch (err) {
      if (err instanceof LlmError) throw new JobFailure('LLM_NOT_CONFIGURED', err.message);
      throw new JobFailure(
        'CONFIGURATION_ERROR',
        'The language model settings on the server are invalid.',
      );
    }
  }

  return {
    async run(job, ctx) {
      const createLlm = resolveCreateLlm();
      let result;
      try {
        result = await runCase(job.input, {
          createLlm,
          allowLoopback: options.config.allowPrivateHosts,
          nodeEnv: options.config.nodeEnv,
          onProgress: (stage, progress) => ctx.report(stage, progress),
          ...(options.research ? { research: options.research } : {}),
          ...(options.caseDeadlineMs === undefined
            ? {}
            : { caseDeadlineMs: options.caseDeadlineMs }),
        });
      } catch (err) {
        if (err instanceof CaseFailure && err.code !== 'INTERNAL_ERROR') {
          throw new JobFailure(err.code, err.message);
        }
        // Unexpected: let the job service log the real error and show the generic message.
        throw err instanceof CaseFailure ? (err.cause ?? err) : err;
      }

      if (result.status === 'incomplete' || result.limitations.length > 0) {
        // Appendix A has no field for these, so they are kept in the server log for the operator.
        options.logger.warn(
          {
            jobId: job.jobId,
            status: result.status,
            incompleteReasons: result.incompleteReasons,
            limitationCount: result.limitations.length,
          },
          'generation finished with gaps',
        );
      }

      const doc = await options.repos.kits.insert(new ObjectId(job.userId), result.kit);
      return { kitId: doc._id.toHexString() };
    },
  };
}
