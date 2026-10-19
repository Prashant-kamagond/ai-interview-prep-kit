import type { Clock } from '../research/clock.js';
import { createLlmClient, type LlmClient, type LlmEvent } from './client.js';
import type { LlmConfig } from './config.js';
import { createGeminiProvider } from './gemini.js';

export interface LlmClientExtras {
  /** Absolute time (clock scale) by which every call must be finished. */
  deadline?: number;
  clock?: Clock;
  onEvent?: (event: LlmEvent) => void;
  /** Test seam for the HTTP layer. */
  fetch?: typeof fetch;
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
  const provider = createGeminiProvider({
    apiKey: config.apiKey,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    ...(extras.fetch ? { fetch: extras.fetch } : {}),
  });
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
