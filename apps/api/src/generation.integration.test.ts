import { afterEach, describe, expect, it } from 'vitest';
import { kitSchema } from '@trao/contracts';
import { validateKit } from '@trao/core';
import { LlmError } from '@trao/pipeline';
import pino from 'pino';
import { conventionalSite } from '../../../packages/pipeline/src/research/test-support/sites.js';
import { DETAILED_JD } from '../../../packages/pipeline/src/stages/test-support/fixtures.js';
import {
  closedPortUrl,
  makeCaseHarness,
  startFixtureSite,
  type CaseHarnessOptions,
  type FixtureSite,
} from '../../../packages/pipeline/src/test-support/case-harness.js';
import { createPipelineRunner } from './jobs/pipeline-runner.js';
import { createHarness, signUp, waitFor, type Harness } from './test/harness.js';

/**
 * The real pipeline runner behind the real HTTP API and a real MongoDB: submit a job, watch it finish,
 * read the kit. The model is a fake, the company site is a local fixture, and nothing leaves the machine.
 */
describe('generation jobs with the real pipeline runner', () => {
  const open: Harness[] = [];
  const sites: FixtureSite[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((h) => h.close()));
    await Promise.all(sites.splice(0).map((s) => s.close()));
  });

  async function boot(caseOptions: CaseHarnessOptions = {}, runnerEnv?: NodeJS.ProcessEnv) {
    const { deps } = makeCaseHarness(caseOptions);
    const h = await createHarness({
      config: { allowPrivateHosts: true },
      createRunner: (repos) =>
        createPipelineRunner({
          repos,
          config: { allowPrivateHosts: true, nodeEnv: 'test' },
          logger: pino({ level: 'silent' }),
          research: deps.research,
          ...(runnerEnv ? { env: runnerEnv } : { createLlm: deps.createLlm }),
        }),
    });
    open.push(h);
    return h;
  }
  async function fixture() {
    const s = await startFixtureSite(conventionalSite());
    sites.push(s);
    return s;
  }
  const finished = (c: Awaited<ReturnType<typeof signUp>>, id: string) =>
    waitFor(
      async () => (await c.get(`/generation-jobs/${id}`)).body.job,
      (job) => job.status === 'succeeded' || job.status === 'failed',
      20_000,
    );

  it('generates a kit, stores it for the owner and exposes it through the kit endpoints', async () => {
    const h = await boot();
    const c = await signUp(h.app);
    const s = await fixture();

    const created = await c.post('/generation-jobs', {
      jd: DETAILED_JD,
      company_url: s.url('/'),
      days: 3,
    });
    expect(created.status).toBe(202);
    const job = await finished(c, created.body.job.id as string);

    expect(job).toMatchObject({ status: 'succeeded', stage: 'done', progress: 100, error: null });
    expect(job.kit_id).toEqual(expect.any(String));

    const kitRes = await c.get(`/kits/${job.kit_id}`);
    expect(kitRes.status).toBe(200);
    const kit = kitRes.body.kit;
    expect(kitSchema.safeParse(kit).success).toBe(true);
    expect(validateKit(kit, { requestedDays: 3 }).ok).toBe(true);
    expect(kit.schedule.days).toHaveLength(3);
    expect(kit.source.company_url).toBe(s.url('/'));
    expect(kit.source.pages_used.length).toBeGreaterThan(0);
    expect(kit.role.requirements.map((r: { id: string }) => r.id)).toEqual([
      'r1',
      'r2',
      'r3',
      'r4',
      'r5',
      'r6',
      'r7',
      'r8',
    ]);

    const list = await c.get('/kits');
    expect(list.body.kits).toHaveLength(1);

    // The kit, its builder state and the research it was built from were stored together.
    expect(job).toMatchObject({ kind: 'generate', report: null });
    const builder = await c.get(`/kits/${job.kit_id}/builder`);
    expect(builder.status).toBe(200);
    expect(builder.body.research.status).toBe('available');
    expect(builder.body.research.company_url).toBe(s.url('/'));
    expect(builder.body.research.pages.map((p: { url: string }) => p.url).sort()).toEqual(
      [...kit.source.pages_used].sort(),
    );
    expect(builder.body.research.pages.every((p: { text: string }) => p.text.length <= 4000)).toBe(
      true,
    );
    expect(
      builder.body.builder.questions.every((m: { origin: string }) => m.origin === 'generated'),
    ).toBe(true);
  });

  it('keeps the generated kit and the job private to their owner', async () => {
    const h = await boot();
    const owner = await signUp(h.app);
    const other = await signUp(h.app);
    const s = await fixture();
    const created = await owner.post('/generation-jobs', {
      jd: DETAILED_JD,
      company_url: s.url('/'),
      days: 2,
    });
    const job = await finished(owner, created.body.job.id as string);

    expect((await other.get(`/kits/${job.kit_id}`)).status).toBe(404);
    expect((await other.get(`/generation-jobs/${job.id}`)).status).toBe(404);
    expect((await other.get('/kits')).body.kits).toEqual([]);
  });

  it('builds a 60-day schedule when asked for one', async () => {
    const h = await boot();
    const c = await signUp(h.app);
    const s = await fixture();
    const created = await c.post('/generation-jobs', {
      jd: DETAILED_JD,
      company_url: s.url('/'),
      days: 60,
    });
    const job = await finished(c, created.body.job.id as string);
    expect(job.status).toBe('succeeded');
    const kit = (await c.get(`/kits/${job.kit_id}`)).body.kit;
    expect(kit.schedule.days).toHaveLength(60);
  });

  it('rejects days above 60 at the API boundary and starts no job', async () => {
    const h = await boot();
    const c = await signUp(h.app);
    const s = await fixture();
    const res = await c.post('/generation-jobs', {
      jd: DETAILED_JD,
      company_url: s.url('/'),
      days: 61,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(s.server.requests).toHaveLength(0);
  });

  it('fails the job with COMPANY_UNREACHABLE for an unreachable site and creates no kit', async () => {
    const h = await boot();
    const c = await signUp(h.app);
    const created = await c.post('/generation-jobs', {
      jd: DETAILED_JD,
      company_url: await closedPortUrl(),
      days: 4,
    });
    const job = await finished(c, created.body.job.id as string);

    expect(job.status).toBe('failed');
    expect(job.kit_id).toBeNull();
    expect(job.error.code).toBe('COMPANY_UNREACHABLE');
    expect(job.error.message).toMatch(/unreachable/i);
    expect((await c.get('/kits')).body.kits).toEqual([]);
  });

  it('shows a quota failure as a stable code with a curated message, never provider text', async () => {
    const h = await boot({
      handlers: {
        'extract-requirements': () =>
          new LlmError('QUOTA_EXHAUSTED', {
            retryAfterMs: 3_600_000,
            detail: 'sk-SECRET provider text',
          }),
      },
    });
    const c = await signUp(h.app);
    const s = await fixture();
    const created = await c.post('/generation-jobs', {
      jd: DETAILED_JD,
      company_url: s.url('/'),
      days: 3,
    });
    const job = await finished(c, created.body.job.id as string);

    expect(job.status).toBe('failed');
    expect(job.error.code).toBe('LLM_QUOTA_EXHAUSTED');
    expect(JSON.stringify(job)).not.toMatch(/SECRET|sk-/);
  });

  it('fails with LLM_NOT_CONFIGURED when the server has no model key, before touching the company site', async () => {
    const h = await boot({}, {});
    const c = await signUp(h.app);
    const s = await fixture();
    const created = await c.post('/generation-jobs', {
      jd: DETAILED_JD,
      company_url: s.url('/'),
      days: 3,
    });
    const job = await finished(c, created.body.job.id as string);

    expect(job.status).toBe('failed');
    expect(job.error.code).toBe('LLM_NOT_CONFIGURED');
    expect(s.server.requests).toHaveLength(0);
  });

  it('still returns a stored, valid kit when a model stage failed part-way', async () => {
    const h = await boot({ handlers: { flashcards: () => new LlmError('RATE_LIMITED') } });
    const c = await signUp(h.app);
    const s = await fixture();
    const created = await c.post('/generation-jobs', {
      jd: DETAILED_JD,
      company_url: s.url('/'),
      days: 3,
    });
    const job = await finished(c, created.body.job.id as string);
    expect(job.status).toBe('succeeded');
    const kit = (await c.get(`/kits/${job.kit_id}`)).body.kit;
    expect(kit.flashcards).toEqual([]);
    expect(kitSchema.safeParse(kit).success).toBe(true);
  });
});
