import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformKeepAlive } from './serverless.js';
import { SERVERLESS_JOB_STALE_AFTER_MS } from './serverless-limits.js';

/**
 * platformKeepAlive calls the real `waitUntil` from `@vercel/functions`. That package finds the platform's
 * per-request context on a global, so these tests install a fake context there: the package itself is not
 * mocked, which proves the installed version and our call fit together.
 */

const CONTEXT = Symbol.for('@vercel/request-context');
const scope = globalThis as unknown as Record<symbol, unknown>;

afterEach(() => {
  delete scope[CONTEXT];
});

describe('platformKeepAlive', () => {
  it("hands the task to the platform's waitUntil for the current request", () => {
    const waitUntil = vi.fn();
    scope[CONTEXT] = { get: () => ({ waitUntil }) };
    const task = Promise.resolve();
    platformKeepAlive(task);
    expect(waitUntil).toHaveBeenCalledExactlyOnceWith(task);
  });

  it('reads the request context at call time, so each request gets its own', () => {
    const first = vi.fn();
    const second = vi.fn();
    let current = first;
    scope[CONTEXT] = { get: () => ({ waitUntil: current }) };
    platformKeepAlive(Promise.resolve());
    current = second;
    platformKeepAlive(Promise.resolve());
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not on the platform', undefined],
    ['no request in flight', { get: () => undefined }],
    ['a context without waitUntil', { get: () => ({}) }],
  ])('does nothing and does not throw when %s', (_name, holder) => {
    if (holder !== undefined) scope[CONTEXT] = holder;
    expect(() => platformKeepAlive(Promise.resolve())).not.toThrow();
  });
});

describe('the stale-job limit', () => {
  it('is longer than the 300 second default invocation limit of the deployment', () => {
    expect(SERVERLESS_JOB_STALE_AFTER_MS).toBeGreaterThan(300_000);
  });
});
