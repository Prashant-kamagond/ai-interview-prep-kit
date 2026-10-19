import { HostScheduler, type Clock } from './clock.js';
import { FetchError } from './errors.js';
import { hostKey } from './network-policy.js';
import { withRetry, type RetryOptions } from './retry.js';
import type { FetchResult, PerRequestOptions, SafeFetch } from './safe-fetch.js';

export interface PoliteFetcherOptions {
  safeFetch: SafeFetch;
  clock: Clock;
  /** Minimum gap between request starts to the same host. */
  minIntervalMs: number;
  retry: Omit<RetryOptions, 'clock' | 'deadline'>;
  /** Absolute time (clock scale) by which all research must be finished. */
  deadline?: number;
}

/** The message of the error thrown when the research deadline has passed (nothing was sent). */
export const RESEARCH_BUDGET_MESSAGE = 'The research time budget was used up';

export interface PoliteFetcher {
  fetch: (url: string, overrides?: PerRequestOptions) => Promise<FetchResult>;
  setMinInterval(hostKey: string, ms: number): void;
  getMinInterval(hostKey: string): number | undefined;
  /** The default gap between requests to one host. */
  minIntervalMs: number;
  stats: { requests: number };
}

/**
 * The only way research code talks to the network: SSRF-safe fetching, per-host spacing and
 * concurrency, bounded retries with backoff, and a hard research deadline. Each retry attempt is
 * scheduled like a fresh request, so backoff never breaks the per-host spacing.
 */
export function createPoliteFetcher(options: PoliteFetcherOptions): PoliteFetcher {
  const scheduler = new HostScheduler(options.clock, options.minIntervalMs);
  const stats = { requests: 0 };

  const keyFor = (url: string): string => {
    try {
      return hostKey(new URL(url));
    } catch {
      return 'invalid-url'; // safeFetch will reject it with INVALID_URL
    }
  };

  const fetch = (url: string, overrides: PerRequestOptions = {}): Promise<FetchResult> =>
    withRetry(
      () =>
        scheduler.run(keyFor(url), async () => {
          const now = options.clock.now();
          if (options.deadline !== undefined && now >= options.deadline) {
            throw new FetchError('TIMEOUT', RESEARCH_BUDGET_MESSAGE);
          }
          stats.requests++;
          const remaining = options.deadline === undefined ? undefined : options.deadline - now;
          return options.safeFetch(url, {
            ...overrides,
            ...(remaining === undefined
              ? {}
              : { timeoutMs: Math.min(overrides.timeoutMs ?? remaining, remaining) }),
          });
        }),
      {
        ...options.retry,
        clock: options.clock,
        ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
      },
    );

  return {
    fetch,
    setMinInterval: (key, ms) => scheduler.setMinInterval(key, ms),
    getMinInterval: (key) => scheduler.getMinInterval(key),
    minIntervalMs: options.minIntervalMs,
    stats,
  };
}
