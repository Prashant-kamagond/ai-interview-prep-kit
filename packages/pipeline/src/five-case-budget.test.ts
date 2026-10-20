import { afterEach, describe, expect, it } from 'vitest';
import { LlmError } from './llm/errors.js';
import { runBatch, DEFAULT_BATCH_DEADLINE_MS } from './batch.js';
import { createFakeClock, type FakeClock } from './research/test-support/fake-clock.js';
import { conventionalSite, noHiringSite } from './research/test-support/sites.js';
import { DETAILED_JD } from './stages/test-support/fixtures.js';
import {
  goodModelHandlers,
  makeCaseHarness,
  startFixtureSite,
  type FixtureSite,
  type ModelHandlers,
} from './test-support/case-harness.js';

/**
 * The assignment asks for five cases within fifteen minutes "including any retries rate limits force".
 * A real provider cannot be used to check that here, so this simulates one: every model call costs a
 * stated amount of (fake) time, and a rate-limited call makes the client wait the stated Retry-After. The
 * clock is shared, so calls add up one after another, which is the SLOWEST possible schedule (the
 * pipeline overlaps some calls). These tests show how the batch behaves under a stated latency; they are not
 * a measurement of any real model.
 */

const sites: FixtureSite[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
});

const MIN = 60_000;

async function cases() {
  const conventional = await startFixtureSite(conventionalSite());
  const noHiring = await startFixtureSite(noHiringSite());
  sites.push(conventional, noHiring);
  return [
    { id: 'case-01', jd: DETAILED_JD, company_url: conventional.url('/'), days: 5 },
    { id: 'case-02', jd: DETAILED_JD, company_url: noHiring.url('/'), days: 3 },
    { id: 'case-03', jd: DETAILED_JD, company_url: conventional.url('/'), days: 7 },
    { id: 'case-04', jd: DETAILED_JD, company_url: noHiring.url('/'), days: 1 },
    { id: 'case-05', jd: DETAILED_JD, company_url: conventional.url('/'), days: 14 },
  ];
}

/** Wraps every stage so a call costs `latencyMs`, and optionally begins with a rate-limit answer. */
function timed(
  clock: FakeClock,
  latencyMs: number,
  rateLimit?: { every: number; retryAfterMs: number },
): ModelHandlers {
  const handlers = goodModelHandlers();
  let calls = 0;
  const wrapped: ModelHandlers = {};
  for (const [stage, handler] of Object.entries(handlers)) {
    wrapped[stage] = async (request, n) => {
      calls += 1;
      if (rateLimit && calls % rateLimit.every === 0) {
        throw new LlmError('RATE_LIMITED', { retryAfterMs: rateLimit.retryAfterMs });
      }
      clock.advance(latencyMs);
      return handler(request, n);
    };
  }
  return wrapped;
}

async function run(options: {
  latencyMs: number;
  rateLimit?: { every: number; retryAfterMs: number };
  maxRetries?: number;
}) {
  const clock = createFakeClock(0);
  const { deps, provider } = makeCaseHarness({
    handlers: timed(clock, options.latencyMs, options.rateLimit),
    clock,
    maxRetries: options.maxRetries ?? 3,
  });
  const start = clock.now();
  const { output } = await runBatch(await cases(), { ...deps, clock }, { clock });
  return { output, elapsedMs: clock.now() - start, calls: provider.calls.length };
}

describe('five cases against the fifteen-minute budget (simulated model, shared fake clock)', () => {
  it('fits easily at a typical latency: every case ok, well inside the budget', async () => {
    const { output, elapsedMs, calls } = await run({ latencyMs: 6_000 });
    expect(output.kits.map((k) => k.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(output.kits.map((k) => (k.status === 'ok' ? k.kit.schedule.days.length : 0))).toEqual([
      5, 3, 7, 1, 14,
    ]);
    // 7 model calls per case x 6 s, all counted one after another: about 42 s a case
    expect(calls).toBe(35);
    expect(elapsedMs).toBe(35 * 6_000);
    expect(elapsedMs).toBeLessThan(15 * MIN);
  });

  it('still fits when a quarter of the calls are rate limited and each makes the client wait 20 s', async () => {
    const { output, elapsedMs } = await run({
      latencyMs: 6_000,
      rateLimit: { every: 4, retryAfterMs: 20_000 },
    });
    expect(output.kits.every((k) => k.status === 'ok')).toBe(true);
    expect(elapsedMs).toBeLessThan(15 * MIN);
  });

  it('with a slow model the batch stops starting cases at its budget, and records the rest as failed, never silently', async () => {
    // 60 s per call: one case needs 7 calls, far over its own 90 s budget
    const { output, elapsedMs } = await run({ latencyMs: 60_000 });
    expect(output.kits).toHaveLength(5); // one entry per input case, in order
    expect(output.kits.map((k) => k.id)).toEqual([
      'case-01',
      'case-02',
      'case-03',
      'case-04',
      'case-05',
    ]);
    for (const result of output.kits) {
      if (result.status === 'failed') expect(result.error.code).toMatch(/^[A-Z_]+$/);
    }
    // the whole run stays inside the batch budget (14 minutes) and so inside fifteen
    expect(elapsedMs).toBeLessThanOrEqual(DEFAULT_BATCH_DEADLINE_MS);
    expect(DEFAULT_BATCH_DEADLINE_MS).toBeLessThan(15 * MIN);
  });

  it('a provider that keeps rate limiting with long waits fails cases honestly instead of hanging', async () => {
    const { output, elapsedMs } = await run({
      latencyMs: 5_000,
      rateLimit: { every: 1, retryAfterMs: 120_000 },
      maxRetries: 2,
    });
    expect(output.kits).toHaveLength(5);
    expect(output.kits.every((k) => k.status === 'failed')).toBe(true);
    expect(elapsedMs).toBeLessThanOrEqual(DEFAULT_BATCH_DEADLINE_MS);
  });
});
