import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { job } from '../../test/jobs';
import type { JobView } from '../../lib/api/jobs';
import {
  MAX_CONSECUTIVE_ERRORS,
  POLL_INTERVAL_MS,
  describeJobFailure,
  describeStage,
  initialTrackState,
  jobOutcome,
  trackJob,
  trackReducer,
  type TrackState,
} from './tracker';

const succeeded = job({
  status: 'succeeded',
  stage: 'done',
  progress: 100,
  kit_id: 'k'.repeat(24),
});
const failed = job({ status: 'failed', error: { code: 'COMPANY_UNREACHABLE', message: 'x' } });

describe('jobOutcome', () => {
  it('is active while queued or running', () => {
    expect(jobOutcome(job({ status: 'queued' })).kind).toBe('active');
    expect(jobOutcome(job()).kind).toBe('active');
  });
  it('is a success only when the API says so and names the kit', () => {
    expect(jobOutcome(succeeded)).toEqual({ kind: 'succeeded', kitId: 'k'.repeat(24) });
    // "succeeded" without a kit is never shown as success
    expect(jobOutcome(job({ status: 'succeeded', kit_id: null }))).toMatchObject({
      kind: 'failed',
      code: 'KIT_MISSING',
    });
  });
  it('carries the failure code and message', () => {
    expect(jobOutcome(failed)).toEqual({
      kind: 'failed',
      code: 'COMPANY_UNREACHABLE',
      message: 'x',
    });
    expect(jobOutcome(job({ status: 'failed', error: null }))).toMatchObject({
      kind: 'failed',
      code: 'UNKNOWN',
    });
  });
  it('does not treat 100% progress on a running job as success', () => {
    expect(jobOutcome(job({ status: 'running', progress: 100 })).kind).toBe('active');
  });
});

describe('wording', () => {
  it('uses our own plain wording for known codes', () => {
    expect(describeJobFailure('COMPANY_UNREACHABLE', 'raw')).toMatch(/could not be reached/);
    expect(describeJobFailure('LLM_RATE_LIMITED', 'raw')).toMatch(/busy/);
    expect(describeJobFailure('SERVER_RESTARTED', 'raw')).toMatch(/submit it again/);
  });
  it('falls back to the server message for an unknown code, then to a generic one', () => {
    expect(describeJobFailure('SOMETHING_NEW', 'Curated server text.')).toBe(
      'Curated server text.',
    );
    expect(describeJobFailure('SOMETHING_NEW', '')).toMatch(/could not be generated/);
  });
  it('describes the stage the server reported, and nothing when none was', () => {
    expect(describeStage(job({ stage: 'researching' }))).toBe('Researching the company');
    expect(describeStage(job({ stage: 'new-stage_name' }))).toBe('new stage name');
    expect(describeStage(job({ stage: null }))).toBeNull();
    expect(describeStage(job({ status: 'queued', stage: null }))).toBe('Waiting to start');
  });
});

describe('trackReducer (state transitions)', () => {
  const run = (
    actions: Parameters<typeof trackReducer>[1][],
    from: TrackState = initialTrackState,
  ) => actions.reduce(trackReducer, from);

  it('keeps tracking while the job is queued or running, and remembers the latest view', () => {
    const queued = job({ status: 'queued', stage: null, progress: null });
    expect(run([{ type: 'update', job: queued }])).toEqual({ phase: 'tracking', job: queued });
    expect(
      run([
        { type: 'update', job: queued },
        { type: 'update', job: job() },
      ]),
    ).toEqual({ phase: 'tracking', job: job() });
  });
  it('finishes on success and on failure', () => {
    expect(run([{ type: 'update', job: succeeded }])).toEqual({
      phase: 'finished',
      job: succeeded,
    });
    expect(run([{ type: 'update', job: failed }])).toEqual({ phase: 'finished', job: failed });
  });
  it('never leaves a finished state, whatever arrives late', () => {
    const done: TrackState = { phase: 'finished', job: succeeded };
    expect(run([{ type: 'update', job: job() }], done)).toBe(done);
    expect(run([{ type: 'interrupted', reason: 'network' }], done)).toBe(done);
    expect(run([{ type: 'resume' }], done)).toBe(done);
  });
  it('is interrupted with the last known job, and resumes only from an interruption', () => {
    const interrupted = run([
      { type: 'update', job: job() },
      { type: 'interrupted', reason: 'network' },
    ]);
    expect(interrupted).toEqual({ phase: 'interrupted', reason: 'network', job: job() });
    expect(run([{ type: 'resume' }], interrupted)).toEqual({ phase: 'tracking', job: job() });
    expect(run([{ type: 'resume' }])).toEqual(initialTrackState);
  });
});

/** A fake API whose answers come from a script, plus a clock the test advances by sleeping. */
function harness(script: (JobView | Error)[]) {
  const calls: number[] = [];
  let clock = 0;
  const sleeps: number[] = [];
  const controller = new AbortController();
  const get = vi.fn(async () => {
    calls.push(clock);
    const next = script.shift();
    if (next === undefined) throw new Error('polled after the script ended');
    if (next instanceof Error) throw next;
    return next;
  });
  const updates: JobView[] = [];
  const run = (extra: Partial<Parameters<typeof trackJob>[2]> = {}) =>
    trackJob({ get }, 'job-1', {
      signal: controller.signal,
      onUpdate: (j) => updates.push(j),
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      ...extra,
    });
  return { get, run, updates, sleeps, controller };
}
const network = () => new ApiError(0, 'NETWORK_ERROR', 'down');

describe('trackJob', () => {
  it('polls at the interval until success, then stops', async () => {
    const h = harness([
      job({ status: 'queued', stage: null, progress: null }),
      job(),
      job({ progress: 40, stage: 'generating' }),
      succeeded,
    ]);
    const result = await h.run();
    expect(result).toEqual({ type: 'finished', job: succeeded });
    expect(h.get).toHaveBeenCalledTimes(4);
    expect(h.sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
    expect(h.updates).toHaveLength(4);
  });

  it('stops on failure and reports the failed job', async () => {
    const h = harness([job(), failed]);
    expect(await h.run()).toEqual({ type: 'finished', job: failed });
    expect(h.get).toHaveBeenCalledTimes(2);
  });

  it('does a single request for a job that is already finished (page reload)', async () => {
    const h = harness([succeeded]);
    expect(await h.run()).toEqual({ type: 'finished', job: succeeded });
    expect(h.get).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
  });

  it('never has two requests in flight', async () => {
    let inFlight = 0;
    let max = 0;
    const answers = [job(), job(), succeeded];
    const get = vi.fn(async () => {
      max = Math.max(max, ++inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return answers.shift()!;
    });
    await trackJob({ get }, 'j', {
      signal: new AbortController().signal,
      onUpdate: () => {},
      sleep: async () => {},
    });
    expect(max).toBe(1);
  });

  it('retries through a short network failure, with growing waits, and recovers', async () => {
    const h = harness([network(), network(), job(), succeeded]);
    expect(await h.run()).toEqual({ type: 'finished', job: succeeded });
    expect(h.sleeps).toEqual([POLL_INTERVAL_MS * 2, POLL_INTERVAL_MS * 4, POLL_INTERVAL_MS]);
  });

  it('gives up after repeated failures instead of looping forever', async () => {
    const h = harness(Array.from({ length: 10 }, network));
    expect(await h.run()).toEqual({ type: 'interrupted', reason: 'network' });
    expect(h.get).toHaveBeenCalledTimes(MAX_CONSECUTIVE_ERRORS);
  });

  it('counts only consecutive failures', async () => {
    const h = harness([
      network(),
      network(),
      network(),
      job(),
      network(),
      network(),
      network(),
      succeeded,
    ]);
    expect(await h.run()).toEqual({ type: 'finished', job: succeeded });
  });

  it.each([[429], [500], [503]])('treats HTTP %i as temporary', async (status) => {
    const h = harness([new ApiError(status, `HTTP_${status}`, 'x'), succeeded]);
    expect(await h.run()).toEqual({ type: 'finished', job: succeeded });
  });

  it('stops at once, with no retry, when the session is gone', async () => {
    const h = harness([job(), new ApiError(401, 'SESSION_EXPIRED', 'x'), succeeded]);
    expect(await h.run()).toEqual({ type: 'interrupted', reason: 'unauthorized' });
    expect(h.get).toHaveBeenCalledTimes(2);
  });

  it('stops at once when the job does not exist or belongs to someone else', async () => {
    const h = harness([new ApiError(404, 'NOT_FOUND', 'x')]);
    expect(await h.run()).toEqual({ type: 'interrupted', reason: 'not-found' });
    expect(h.get).toHaveBeenCalledTimes(1);
  });

  it('stops on other client errors and on non-API errors', async () => {
    expect(await harness([new ApiError(400, 'VALIDATION_ERROR', 'x')]).run()).toEqual({
      type: 'interrupted',
      reason: 'unexpected',
    });
    expect(await harness([new TypeError('boom')]).run()).toEqual({
      type: 'interrupted',
      reason: 'unexpected',
    });
  });

  it('stops after the time limit if the job never finishes', async () => {
    const h = harness(Array.from({ length: 100 }, () => job()));
    expect(await h.run({ maxMs: 10_000 })).toEqual({ type: 'interrupted', reason: 'timeout' });
    expect(h.get.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('ends quietly when aborted, before or during a request', async () => {
    const before = harness([succeeded]);
    before.controller.abort();
    expect(await before.run()).toEqual({ type: 'aborted' });
    expect(before.get).not.toHaveBeenCalled();

    const during = harness([]);
    during.get.mockImplementationOnce(async () => {
      during.controller.abort();
      throw new ApiError(0, 'ABORTED', 'cancelled');
    });
    expect(await during.run()).toEqual({ type: 'aborted' });
  });

  it('ignores a response that arrives after the abort', async () => {
    const h = harness([]);
    h.get.mockImplementationOnce(async () => {
      h.controller.abort();
      return succeeded;
    });
    expect(await h.run()).toEqual({ type: 'aborted' });
    expect(h.updates).toEqual([]);
  });
});
