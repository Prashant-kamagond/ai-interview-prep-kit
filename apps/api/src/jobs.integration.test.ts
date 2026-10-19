import { ObjectId } from 'mongodb';
import { afterEach, describe, expect, it } from 'vitest';
import { makeKit } from '@trao/core/testing';
import { JobFailure, type JobRunner } from './jobs/runner.js';
import {
  controllableRunner,
  createHarness,
  signUp,
  waitFor,
  type Harness,
} from './test/harness.js';

const body = {
  jd: 'Senior Backend Engineer\n\nMust have 5 years of Node.',
  company_url: 'http://localhost:8099/acme/',
  days: 5,
};

describe('generation jobs', () => {
  const open: Harness[] = [];
  async function harness(runner?: JobRunner) {
    const h = await createHarness(runner ? { runner } : {});
    open.push(h);
    return h;
  }
  afterEach(async () => {
    await Promise.all(open.splice(0).map((h) => h.close()));
  });

  it('returns 202 with a job id and a Location header, and persists the job', async () => {
    const ctl = controllableRunner();
    const h = await harness(ctl.runner);
    const c = await signUp(h.app);

    const res = await c.post('/generation-jobs', body);
    expect(res.status).toBe(202);
    expect(res.body.deduplicated).toBe(false);
    expect(res.body.job).toMatchObject({ id: expect.any(String), status: 'queued' });
    expect(res.headers.location).toBe(`/generation-jobs/${res.body.job.id}`);

    const doc = await h.db
      .collection('generation_jobs')
      .findOne({ _id: new ObjectId(res.body.job.id as string) });
    expect(doc).toMatchObject({ inputHash: expect.stringMatching(/^[0-9a-f]{64}$/), active: true });
    expect(doc?.userId).toBeInstanceOf(ObjectId);
    ctl.fail(new JobFailure('TEST_CLEANUP', 'cleanup'));
  });

  it('reports running status and stage progress through the status endpoint', async () => {
    const ctl = controllableRunner();
    const h = await harness(ctl.runner);
    const c = await signUp(h.app);
    const { body: created } = await c.post('/generation-jobs', body);

    const status = await waitFor(
      async () => (await c.get(`/generation-jobs/${created.job.id}`)).body.job,
      (job) => job.status === 'running' && job.stage === 'researching',
    );
    expect(status).toMatchObject({ progress: 25, kit_id: null, error: null, finished_at: null });
    expect(status.started_at).toEqual(expect.any(String));
    // The response never exposes the request payload or its hash.
    expect(JSON.stringify(status)).not.toMatch(/inputHash|userId|Senior Backend/);
    ctl.fail(new JobFailure('TEST_CLEANUP', 'cleanup'));
  });

  it('fails honestly with PIPELINE_NOT_IMPLEMENTED when no real pipeline exists', async () => {
    const h = await harness(); // default runner
    const c = await signUp(h.app);
    const { body: created } = await c.post('/generation-jobs', body);
    await h.jobs.settled();

    const res = await c.get(`/generation-jobs/${created.job.id}`);
    expect(res.status).toBe(200);
    expect(res.body.job.status).toBe('failed');
    expect(res.body.job.kit_id).toBeNull();
    expect(res.body.job.error.code).toBe('PIPELINE_NOT_IMPLEMENTED');
    expect(res.body.job.finished_at).toEqual(expect.any(String));
  });

  it('marks a job succeeded only when the runner returns a kit the user owns', async () => {
    const ctl = controllableRunner();
    const h = await harness(ctl.runner);
    const c = await signUp(h.app);
    const { body: created } = await c.post('/generation-jobs', body);
    const kit = await c.post('/kits', { kit: makeKit() });

    await waitFor(
      () => ctl.calls.length,
      (n) => n === 1,
    );
    ctl.release(kit.body.id);
    await h.jobs.settled();

    const res = await c.get(`/generation-jobs/${created.job.id}`);
    expect(res.body.job).toMatchObject({ status: 'succeeded', kit_id: kit.body.id, progress: 100 });
    expect(await h.db.collection('generation_jobs').countDocuments({ active: true })).toBe(0);
  });

  it("refuses to mark a job succeeded with a kit id that is not the user's", async () => {
    const ctl = controllableRunner();
    const h = await harness(ctl.runner);
    const alice = await signUp(h.app);
    const bob = await signUp(h.app);
    const { body: created } = await alice.post('/generation-jobs', body);
    const bobsKit = await bob.post('/kits', { kit: makeKit() });

    await waitFor(
      () => ctl.calls.length,
      (n) => n === 1,
    );
    ctl.release(bobsKit.body.id);
    await h.jobs.settled();

    const res = await alice.get(`/generation-jobs/${created.job.id}`);
    expect(res.body.job.status).toBe('failed');
    expect(res.body.job.kit_id).toBeNull();
  });

  it('records a generic safe error when the runner throws an unexpected error', async () => {
    const ctl = controllableRunner();
    const h = await harness(ctl.runner);
    const c = await signUp(h.app);
    const { body: created } = await c.post('/generation-jobs', body);
    await waitFor(
      () => ctl.calls.length,
      (n) => n === 1,
    );
    ctl.fail(new Error('mongodb://admin:hunter2@internal-host:27017 exploded at /srv/app.ts:12'));
    await h.jobs.settled();

    const res = await c.get(`/generation-jobs/${created.job.id}`);
    expect(res.body.job.status).toBe('failed');
    expect(res.body.job.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|internal-host|app\.ts/);
  });

  it('keeps a runner-supplied failure code and message', async () => {
    const ctl = controllableRunner();
    const h = await harness(ctl.runner);
    const c = await signUp(h.app);
    const { body: created } = await c.post('/generation-jobs', body);
    await waitFor(
      () => ctl.calls.length,
      (n) => n === 1,
    );
    ctl.fail(new JobFailure('COMPANY_UNREACHABLE', 'Company site unreachable after 3 retries.'));
    await h.jobs.settled();

    const res = await c.get(`/generation-jobs/${created.job.id}`);
    expect(res.body.job.error).toEqual({
      code: 'COMPANY_UNREACHABLE',
      message: 'Company site unreachable after 3 retries.',
    });
  });

  describe('deduplication', () => {
    it('returns the in-progress job for an equivalent request instead of starting another', async () => {
      const ctl = controllableRunner();
      const h = await harness(ctl.runner);
      const c = await signUp(h.app);

      const first = await c.post('/generation-jobs', body);
      const second = await c.post('/generation-jobs', {
        jd: `  ${body.jd.replace(/\n/g, '\r\n')}  `,
        company_url: 'HTTP://localhost:8099/acme',
        days: 5,
      });

      expect(second.status).toBe(202);
      expect(second.body.deduplicated).toBe(true);
      expect(second.body.job.id).toBe(first.body.job.id);
      expect(await h.db.collection('generation_jobs').countDocuments()).toBe(1);
      await waitFor(
        () => ctl.calls.length,
        (n) => n >= 1,
      );
      expect(ctl.calls).toHaveLength(1);
      ctl.fail(new JobFailure('TEST_CLEANUP', 'cleanup'));
    });

    it('creates exactly one job and one run for many simultaneous identical requests', async () => {
      const ctl = controllableRunner();
      const h = await harness(ctl.runner);
      const c = await signUp(h.app);

      const results = await Promise.all(
        Array.from({ length: 12 }, () => c.post('/generation-jobs', body)),
      );
      expect(results.every((r) => r.status === 202)).toBe(true);
      expect(new Set(results.map((r) => r.body.job.id)).size).toBe(1);
      expect(results.filter((r) => r.body.deduplicated === false)).toHaveLength(1);
      expect(await h.db.collection('generation_jobs').countDocuments()).toBe(1);

      await waitFor(
        () => ctl.calls.length,
        (n) => n >= 1,
      );
      await new Promise((r) => setTimeout(r, 100));
      expect(ctl.calls).toHaveLength(1);
      ctl.fail(new JobFailure('TEST_CLEANUP', 'cleanup'));
    });

    it('treats a different day count, or a different user, as a different request', async () => {
      const ctl = controllableRunner();
      const h = await harness(ctl.runner);
      const a = await signUp(h.app);
      const b = await signUp(h.app);

      const ids = [
        (await a.post('/generation-jobs', body)).body.job.id,
        (await a.post('/generation-jobs', { ...body, days: 6 })).body.job.id,
        (await b.post('/generation-jobs', body)).body.job.id,
      ];
      expect(new Set(ids).size).toBe(3);
      ctl.fail(new JobFailure('TEST_CLEANUP', 'cleanup'));
    });

    it('allows the same request again once the earlier job has finished', async () => {
      const h = await harness(); // default runner fails immediately
      const c = await signUp(h.app);
      const first = await c.post('/generation-jobs', body);
      await h.jobs.settled();
      const second = await c.post('/generation-jobs', body);
      expect(second.body.deduplicated).toBe(false);
      expect(second.body.job.id).not.toBe(first.body.job.id);
    });
  });

  describe('validation and ownership', () => {
    it.each([
      ['empty description', { ...body, jd: '   ' }],
      ['zero days', { ...body, days: 0 }],
      ['61 days', { ...body, days: 61 }],
      ['fractional days', { ...body, days: 2.5 }],
      ['string days', { ...body, days: '5' }],
      ['bad url', { ...body, company_url: 'not a url' }],
      ['non-http url', { ...body, company_url: 'file:///etc/passwd' }],
      ['missing fields', {}],
    ])('rejects %s', async (_n, payload) => {
      const h = await harness();
      const c = await signUp(h.app);
      const res = await c.post('/generation-jobs', payload);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(await h.db.collection('generation_jobs').countDocuments()).toBe(0);
    });

    it.each([1, 60])('accepts the boundary of %i day(s)', async (days) => {
      const h = await harness();
      const c = await signUp(h.app);
      expect((await c.post('/generation-jobs', { ...body, days })).status).toBe(202);
    });

    it('accepts a two-line stub description (a thin kit is valid, not an input error)', async () => {
      const h = await harness();
      const c = await signUp(h.app);
      const res = await c.post('/generation-jobs', { ...body, jd: 'Engineer\nWanted ASAP' });
      expect(res.status).toBe(202);
    });

    it("hides other users' jobs and answers like a missing job", async () => {
      const ctl = controllableRunner();
      const h = await harness(ctl.runner);
      const alice = await signUp(h.app);
      const bob = await signUp(h.app);
      const { body: created } = await alice.post('/generation-jobs', body);

      const stolen = await bob.get(`/generation-jobs/${created.job.id}`);
      const missing = await bob.get(`/generation-jobs/${new ObjectId().toHexString()}`);
      const malformed = await bob.get('/generation-jobs/nope');
      for (const res of [stolen, missing, malformed]) {
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      expect((await alice.get(`/generation-jobs/${created.job.id}`)).status).toBe(200);
      ctl.fail(new JobFailure('TEST_CLEANUP', 'cleanup'));
    });
  });

  describe('lifecycle rules', () => {
    it('does not allow illegal transitions at the repository level', async () => {
      const h = await harness();
      const c = await signUp(h.app);
      const { body: created } = await c.post('/generation-jobs', body);
      await h.jobs.settled(); // now failed
      const id = new ObjectId(created.job.id as string);

      expect(await h.repos.jobs.transition(id, 'running')).toBeNull();
      expect(await h.repos.jobs.transition(id, 'succeeded', { kitId: new ObjectId() })).toBeNull();
      const doc = await h.db.collection('generation_jobs').findOne({ _id: id });
      expect(doc?.status).toBe('failed');
    });

    it('cannot jump from queued straight to succeeded', async () => {
      const h = await harness();
      const c = await signUp(h.app);
      const user = await h.db.collection('users').findOne({});
      const queued = await h.repos.jobs.insertActive({
        userId: user!._id as ObjectId,
        inputHash: 'f'.repeat(64),
        input: body,
      });
      const id = queued.job._id;
      expect(await h.repos.jobs.transition(id, 'succeeded', { kitId: new ObjectId() })).toBeNull();
      expect(await h.repos.jobs.transition(id, 'running')).not.toBeNull();
      void c;
    });

    it('marks jobs left active by a previous process as failed on startup, and frees dedup', async () => {
      const h = await harness();
      const c = await signUp(h.app);
      const user = await h.db.collection('users').findOne({});
      const orphan = await h.repos.jobs.insertActive({
        userId: user!._id as ObjectId,
        inputHash: 'a'.repeat(64),
        input: body,
      });
      await h.repos.jobs.transition(orphan.job._id, 'running');

      expect(await h.jobs.failInterrupted()).toBe(1);

      const doc = await h.db.collection('generation_jobs').findOne({ _id: orphan.job._id });
      expect(doc).toMatchObject({
        status: 'failed',
        active: false,
        error: { code: 'SERVER_RESTARTED' },
      });
      void c;
    });
  });
});
