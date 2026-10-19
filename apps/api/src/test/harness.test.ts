import { describe, expect, it } from 'vitest';
import { JobFailure } from '../jobs/runner.js';
import { controllableRunner } from './harness.js';

describe('controllableRunner', () => {
  it('does not raise an unhandled rejection when it is failed before the runner starts waiting', async () => {
    // Integration tests call fail() right after submitting a job, which can be before the job's
    // runner has reached its `await` (it first does a database round trip). A rejected promise
    // with no handler attached yet is an unhandled rejection, and vitest fails the whole run for it.
    const ctl = controllableRunner();
    ctl.fail(new JobFailure('TEST_CLEANUP', 'cleanup'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The runner, arriving late, still sees the failure.
    await expect(
      ctl.runner.run(
        { jobId: 'j', userId: 'u', input: { jd: 'x', company_url: 'http://a.test/', days: 1 } },
        { report: async () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'TEST_CLEANUP' });
    expect(ctl.calls).toHaveLength(1);
  });
});
