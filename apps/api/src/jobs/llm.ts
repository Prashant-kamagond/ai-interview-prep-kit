import {
  LlmError,
  createLlmClientFromConfig,
  loadLlmConfig,
  type RunCaseDeps,
} from '@trao/pipeline';
import { JobFailure } from './runner.js';

/**
 * How a job gets its model client: an injected one (tests use a fake), or one built from the LLM_*
 * variables. The settings are read when a job runs, not when the server starts, so a server without a
 * key still serves everything else and fails these jobs with LLM_NOT_CONFIGURED.
 */
export function resolveCreateLlm(options: {
  createLlm?: RunCaseDeps['createLlm'] | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}): RunCaseDeps['createLlm'] {
  if (options.createLlm) return options.createLlm;
  try {
    const config = loadLlmConfig(options.env ?? process.env);
    return ({ deadline, clock }) => createLlmClientFromConfig(config, { deadline, clock });
  } catch (err) {
    if (err instanceof LlmError) throw new JobFailure('LLM_NOT_CONFIGURED', err.message);
    throw new JobFailure(
      'CONFIGURATION_ERROR',
      'The language model settings on the server are invalid.',
    );
  }
}
