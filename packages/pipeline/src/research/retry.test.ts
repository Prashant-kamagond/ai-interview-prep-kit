import { describe, expect, it } from 'vitest';
import { FetchError } from './errors.js';
import { withRetry } from './retry.js';
import { createFakeClock } from './test-support/fake-clock.js';

const transient = () => new FetchError('HTTP_ERROR', 'HTTP 503', { status: 503, retryable: true });

function opts(overrides: Partial<Parameters<typeof withRetry>[1]> = {}) {
  const clock = createFakeClock();
  return {
    clock,
    options: {
      maxRetries: 3,
      baseDelayMs: 500,
      maxDelayMs: 8000,
      maxRetryAfterMs: 10_000,
      clock,
      random: () => 1, // jitter factor 1 → the full computed delay, so assertions are exact
      ...overrides,
    },
  };
}

describe('withRetry', () => {
  it('returns immediately on success without sleeping', async () => {
    const { clock, options } = opts();
    expect(await withRetry(async () => 'ok', options)).toBe('ok');
    expect(clock.sleeps).toEqual([]);
  });

  it('retries transient failures with exponential backoff, then succeeds', async () => {
    const { clock, options } = opts();
    let calls = 0;
    const result = await withRetry(async () => {
      if (++calls < 4) throw transient();
      return 'finally';
    }, options);
    expect(result).toBe('finally');
    expect(calls).toBe(4);
    expect(clock.sleeps).toEqual([500, 1000, 2000]);
  });

  it('gives up after maxRetries retries and reports how many attempts were made', async () => {
    const { clock, options } = opts({ maxRetries: 3 });
    let calls = 0;
    const err = (await withRetry(async () => {
      calls++;
      throw transient();
    }, options).catch((e: unknown) => e)) as FetchError;
    expect(calls).toBe(4); // 1 attempt + 3 retries: bounded, never indefinite
    expect(err).toBeInstanceOf(FetchError);
    expect(err.attempts).toBe(4);
    expect(clock.sleeps).toHaveLength(3);
  });

  it('does not retry permanent failures', async () => {
    const { clock, options } = opts();
    let calls = 0;
    const err = (await withRetry(async () => {
      calls++;
      throw new FetchError('HTTP_ERROR', 'HTTP 404', { status: 404 });
    }, options).catch((e: unknown) => e)) as FetchError;
    expect(calls).toBe(1);
    expect(err.attempts).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('does not retry unexpected (non-fetch) errors', async () => {
    const { options } = opts();
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new TypeError('bug');
      }, options),
    ).rejects.toThrow(TypeError);
    expect(calls).toBe(1);
  });

  it('caps the backoff at maxDelayMs', async () => {
    const { clock, options } = opts({ maxRetries: 6, baseDelayMs: 1000, maxDelayMs: 3000 });
    await withRetry(async () => {
      throw transient();
    }, options).catch(() => undefined);
    expect(clock.sleeps).toEqual([1000, 2000, 3000, 3000, 3000, 3000]);
  });

  it('applies equal jitter: between half and all of the computed delay', async () => {
    const low = opts({ random: () => 0 });
    await withRetry(async () => {
      throw transient();
    }, low.options).catch(() => undefined);
    expect(low.clock.sleeps).toEqual([250, 500, 1000]);
  });

  it('honours Retry-After when it is longer than the backoff, up to a cap', async () => {
    const { clock, options } = opts({ maxRetries: 2, maxRetryAfterMs: 4000 });
    let calls = 0;
    await withRetry(async () => {
      calls++;
      throw new FetchError('HTTP_ERROR', 'HTTP 429', {
        status: 429,
        retryable: true,
        retryAfterMs: calls === 1 ? 3000 : 60_000,
      });
    }, options).catch(() => undefined);
    expect(clock.sleeps).toEqual([3000, 4000]);
  });

  it('stops retrying when the next wait would pass the deadline', async () => {
    const clock = createFakeClock(0);
    let calls = 0;
    const err = (await withRetry(
      async () => {
        calls++;
        throw transient();
      },
      {
        maxRetries: 5,
        baseDelayMs: 1000,
        maxDelayMs: 8000,
        maxRetryAfterMs: 10_000,
        clock,
        random: () => 1,
        deadline: 2500, // waits would be 1000 then 2000 (cumulative 3000 > 2500)
      },
    ).catch((e: unknown) => e)) as FetchError;
    expect(calls).toBe(2);
    expect(err.attempts).toBe(2);
    expect(clock.sleeps).toEqual([1000]);
  });
});
