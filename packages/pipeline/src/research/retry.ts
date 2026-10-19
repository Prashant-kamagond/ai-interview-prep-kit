import type { Clock } from './clock.js';
import { FetchError } from './errors.js';

export interface RetryOptions {
  /** Retries after the first attempt, so total attempts are at most `maxRetries + 1`. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Upper bound on how long a server's Retry-After can make us wait. */
  maxRetryAfterMs: number;
  clock: Clock;
  /** Injected for deterministic tests. Defaults to Math.random. */
  random?: () => number;
  /** Absolute time (clock.now() scale) after which no further retry is started. */
  deadline?: number;
}

/**
 * Bounded retry with exponential backoff and equal jitter. Only errors flagged `retryable`
 * (timeouts, connection errors, HTTP 429/5xx) are retried; permanent failures and unexpected
 * errors are not. Retry-After is honoured but capped, and no retry is begun if its wait would end
 * after the deadline. The error that is finally thrown records how many attempts were made.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (!(err instanceof FetchError)) throw err;
      err.attempts = attempt;
      if (!err.retryable || attempt > options.maxRetries) throw err;

      const backoff = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      let delay = backoff * (0.5 + 0.5 * random());
      if (err.retryAfterMs !== undefined) {
        delay = Math.max(delay, Math.min(err.retryAfterMs, options.maxRetryAfterMs));
      }
      if (options.deadline !== undefined && options.clock.now() + delay >= options.deadline)
        throw err;

      await options.clock.sleep(delay);
    }
  }
}
