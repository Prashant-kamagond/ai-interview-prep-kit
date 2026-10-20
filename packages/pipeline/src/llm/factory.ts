import type { Clock } from '../research/clock.js';
import { createLlmClient, type LlmClient, type LlmEvent } from './client.js';
import type { LlmConfig } from './config.js';
import { createGeminiProvider } from './gemini.js';
import { createGroqProvider } from './groq.js';
import { LlmError } from './errors.js';
import type { LlmProvider } from './types.js';

export interface LlmClientExtras {
  /** Absolute time (clock scale) by which every call must be finished. */
  deadline?: number;
  clock?: Clock;
  onEvent?: (event: LlmEvent) => void;
  /** Test seam for the HTTP layer. */
  fetch?: typeof fetch;
}

function createProvider(config: LlmConfig, extras: LlmClientExtras): LlmProvider {
  const common = {
    apiKey: config.apiKey,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    ...(extras.fetch ? { fetch: extras.fetch } : {}),
  };
  switch (config.provider) {
    case 'gemini':
      return createGeminiProvider(common);
    case 'groq':
      return createGroqProvider(common);
    default:
      // Only reachable if a caller builds a config by hand; loadLlmConfig never returns another value.
      throw new LlmError('INVALID_REQUEST', {
        message:
          'The configured LLM provider is not supported. Set LLM_PROVIDER to gemini or groq.',
      });
  }
}

/**
 * Builds the client the application uses: the configured model on the configured provider, with
 * the configured timeout, retry, concurrency and pacing limits. The model is never substituted:
 * if it is unavailable the calls fail with MODEL_NOT_FOUND.
 */
export function createLlmClientFromConfig(
  config: LlmConfig,
  extras: LlmClientExtras = {},
): LlmClient {
  const provider = createProvider(config, extras);
  return createLlmClient({
    provider,
    requestTimeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    maxConcurrency: config.maxConcurrency,
    minIntervalMs: config.minIntervalMs,
    ...(extras.deadline === undefined ? {} : { deadline: extras.deadline }),
    ...(extras.clock ? { clock: extras.clock } : {}),
    ...(extras.onEvent ? { onEvent: extras.onEvent } : {}),
  });
}
