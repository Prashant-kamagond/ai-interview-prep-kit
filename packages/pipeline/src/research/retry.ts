import type { Clock } from './clock.js';

/**
 * The contract withRetry understands: an error says whether it is worth retrying, may carry a
 * server-requested delay, and records how many attempts were made. FetchError (network research)
 * and LlmError (model calls) both satisfy it.
 */
export interface RetryableErrorLike extends Error {
  retryable: boolean;
  retryAfterMs?: number | undefined;
  attempts: number;
}

export function isRetryableErrorLike(err: unknown): err is RetryableErrorLike {
  return (
    err instanceof Error &&
    typeof (err as { retryable?: unknown }).retryable === 'boolean' &&
    typeof (err as { attempts?: unknown }).attempts === 'number'
  );
}

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
  /** Called just before each backoff wait, for observability. */
  onRetry?: (info: { attempt: number; delayMs: number; error: RetryableErrorLike }) => void;
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
      if (!isRetryableErrorLike(err)) throw err;
      err.attempts = attempt;
      if (!err.retryable || attempt > options.maxRetries) throw err;

      const backoff = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      // A server that asks for longer than we are willing to wait will not succeed after a shorter
      // nap (a daily quota says "come back in 20 hours"), so retrying would only waste time.
      if (err.retryAfterMs !== undefined && err.retryAfterMs > options.maxRetryAfterMs) throw err;
      let delay = backoff * (0.5 + 0.5 * random());
      if (err.retryAfterMs !== undefined) delay = Math.max(delay, err.retryAfterMs);
      if (options.deadline !== undefined && options.clock.now() + delay >= options.deadline)
        throw err;

      options.onRetry?.({ attempt, delayMs: delay, error: err });
      await options.clock.sleep(delay);
    }
  }
}
