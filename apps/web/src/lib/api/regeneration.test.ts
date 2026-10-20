import { describe, expect, it, vi } from 'vitest';
import { job } from '../../test/jobs';
import { ApiError, type ApiClient } from './client';
import { RegenerationInProgress, RegenerationRefused, createRegenerationApi } from './regeneration';

const ID = 'a'.repeat(24);
const JOB_ID = 'b'.repeat(24);

function apiWith(result: unknown) {
  const post = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { api: createRegenerationApi({ post } as unknown as ApiClient), post };
}

describe('regeneration api: start', () => {
  it('posts the section request to the kit and returns the job', async () => {
    const { api, post } = apiWith({
      job: job({ id: JOB_ID, status: 'queued' }),
      deduplicated: false,
    });
    const out = await api.start(ID, { section: 'questions', category: 'technical' });
    expect(out.deduplicated).toBe(false);
    expect(out.job.id).toBe(JOB_ID);
    expect(post).toHaveBeenCalledWith(
      `/kits/${ID}/regenerations`,
      { section: 'questions', category: 'technical' },
      undefined,
    );
  });

  it('encodes the kit id', async () => {
    const { api, post } = apiWith({ job: job({ id: JOB_ID }), deduplicated: true });
    await api.start('../auth/me', { section: 'schedule' });
    expect(post).toHaveBeenCalledWith(
      '/kits/..%2Fauth%2Fme/regenerations',
      { section: 'schedule' },
      undefined,
    );
  });

  it("turns a 422 into a refusal carrying the server's reason and explanation, with no job", async () => {
    const refusal = new ApiError(
      422,
      'REGENERATION_UNAVAILABLE',
      'The brief cannot be regenerated: research was not kept.',
      {
        reason: 'RESEARCH_UNAVAILABLE',
        section: 'brief',
      },
    );
    const { api } = apiWith(refusal);
    const error = await api.start(ID, { section: 'brief' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RegenerationRefused);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      reason: 'RESEARCH_UNAVAILABLE',
      message: 'The brief cannot be regenerated: research was not kept.',
    });
  });

  it('turns a 409 into "already running", with that job\'s id', async () => {
    const { api } = apiWith(
      new ApiError(409, 'REGENERATION_IN_PROGRESS', 'Another is running.', { job_id: JOB_ID }),
    );
    const error = await api.start(ID, { section: 'schedule' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RegenerationInProgress);
    expect(error).toMatchObject({ jobId: JOB_ID });
  });

  it('does not trust a job id that is not a job id', async () => {
    for (const bad of ['../x', '', 5, undefined]) {
      const { api } = apiWith(new ApiError(409, 'REGENERATION_IN_PROGRESS', 'x', { job_id: bad }));
      const error = await api.start(ID, { section: 'schedule' }).catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(RegenerationInProgress);
      expect(error).toMatchObject({ status: 409 });
    }
  });

  it.each([
    [new ApiError(401, 'SESSION_EXPIRED', 'x'), 401],
    [new ApiError(404, 'NOT_FOUND', 'x'), 404],
    [new ApiError(400, 'VALIDATION_ERROR', 'x'), 400],
    [new ApiError(0, 'NETWORK_ERROR', 'x'), 0],
    [new ApiError(500, 'INTERNAL_ERROR', 'x'), 500],
  ])('passes other errors through unchanged (%#)', async (error, status) => {
    const { api } = apiWith(error);
    await expect(api.start(ID, { section: 'brief' })).rejects.toMatchObject({ status });
  });

  it.each([
    ['text'],
    [null],
    [{}],
    [{ job: { id: 'x', status: 'weird' }, deduplicated: false }],
    [{ job: job(), deduplicated: 'no' }],
  ])('refuses a success body it cannot read (%#)', async (body) => {
    const { api } = apiWith(body);
    await expect(api.start(ID, { section: 'brief' })).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
  });
});
