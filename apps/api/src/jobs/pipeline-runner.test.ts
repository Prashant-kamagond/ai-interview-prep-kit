import { ObjectId } from 'mongodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { kitSchema, type Kit } from '@trao/contracts';
import { LlmError, runBatch } from '@trao/pipeline';
import { conventionalSite } from '../../../../packages/pipeline/src/research/test-support/sites.js';
import { DETAILED_JD } from '../../../../packages/pipeline/src/stages/test-support/fixtures.js';
import {
  closedPortUrl,
  makeCaseHarness,
  startFixtureSite,
  type FixtureSite,
} from '../../../../packages/pipeline/src/test-support/case-harness.js';
import { createPipelineRunner } from './pipeline-runner.js';
import { JobFailure, type JobRunInput, type JobRunnerContext } from './runner.js';

const sites: FixtureSite[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
});
async function site() {
  const s = await startFixtureSite(conventionalSite());
  sites.push(s);
  return s;
}

const SECRET = 'AQ.SECRET-VALUE-THAT-MUST-NEVER-LEAK';
const userId = new ObjectId();

/** Repositories stand-in: records the kit that would be stored. */
function fakeRepos() {
  const stored: { userId: ObjectId; kit: Kit }[] = [];
  const id = new ObjectId();
  return {
    stored,
    id,
    repos: {
      kits: {
        insert: async (owner: ObjectId, kit: Kit) => {
          stored.push({ userId: owner, kit });
          return { _id: id } as never;
        },
      },
    } as never,
  };
}

function job(company_url: string, days = 5, jd = DETAILED_JD): JobRunInput {
  return {
    jobId: new ObjectId().toHexString(),
    userId: userId.toHexString(),
    input: { jd, company_url, days },
  };
}

function context() {
  const reports: [string, number][] = [];
  const ctx: JobRunnerContext = {
    report: async (stage, progress) => void reports.push([stage, progress]),
  };
  return { ctx, reports };
}

const logger = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) as never;

async function failureOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the job to fail');
}

describe('the pipeline runner', () => {
  it('runs the pipeline, stores the kit for the job owner and returns its id', async () => {
    const s = await site();
    const { repos, stored, id } = fakeRepos();
    const { deps } = makeCaseHarness();
    const runner = createPipelineRunner({
      repos,
      config: { allowPrivateHosts: true, nodeEnv: 'test' },
      logger: logger(),
      createLlm: deps.createLlm,
      research: deps.research,
    });
    const { ctx, reports } = context();
    const out = await runner.run(job(s.url('/'), 7), ctx);

    expect(out).toEqual({ kitId: id.toHexString() });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.userId.equals(userId)).toBe(true);
    expect(kitSchema.safeParse(stored[0]!.kit).success).toBe(true);
    expect(stored[0]!.kit.schedule.days).toHaveLength(7);
    expect(reports.map(([stage]) => stage)).toEqual(['researching', 'generating', 'finalizing']);
  });

  it('produces exactly the kit the batch command produces for the same input (parity)', async () => {
    const s = await site();
    const { repos, stored } = fakeRepos();
    const api = makeCaseHarness();
    const runner = createPipelineRunner({
      repos,
      config: { allowPrivateHosts: true, nodeEnv: 'test' },
      logger: logger(),
      createLlm: api.deps.createLlm,
      research: api.deps.research,
    });
    await runner.run(job(s.url('/'), 6), context().ctx);

    const cli = makeCaseHarness();
    const batch = await runBatch(
      [{ id: 'x', jd: DETAILED_JD, company_url: s.url('/'), days: 6 }],
      cli.deps,
    );
    const entry = batch.output.kits[0]!;
    expect(entry.status).toBe('ok');
    const strip = (k: Kit) => ({ ...k, source: { ...k.source, researched_at: '' } });
    expect(strip(stored[0]!.kit)).toEqual(strip(entry.kit!));
    // The same questions in the same order with the same ids, and the same number of model calls.
    expect(api.provider.calls).toHaveLength(cli.provider.calls.length);
  });

  it('refuses local company sites unless private hosts are enabled, and stores nothing', async () => {
    const s = await site();
    const { repos, stored } = fakeRepos();
    const { deps } = makeCaseHarness();
    const runner = createPipelineRunner({
      repos,
      config: { allowPrivateHosts: false, nodeEnv: 'test' },
      logger: logger(),
      createLlm: deps.createLlm,
      research: deps.research,
    });
    const err = await failureOf(runner.run(job(s.url('/')), context().ctx));
    expect(err).toBeInstanceOf(JobFailure);
    expect((err as JobFailure).code).toMatch(/^COMPANY_URL_/);
    expect(s.server.requests).toHaveLength(0);
    expect(stored).toHaveLength(0);
  });

  it('never enables local company sites in production, even if the flag were set', async () => {
    const s = await site();
    const { deps } = makeCaseHarness();
    const runner = createPipelineRunner({
      repos: fakeRepos().repos,
      config: { allowPrivateHosts: true, nodeEnv: 'production' },
      logger: logger(),
      createLlm: deps.createLlm,
      research: deps.research,
    });
    const err = (await failureOf(runner.run(job(s.url('/')), context().ctx))) as JobFailure;
    expect(err).toBeInstanceOf(JobFailure);
    expect(err.code).toBe('CONFIGURATION_ERROR');
    expect(s.server.requests).toHaveLength(0);
  });

  it('fails the job with COMPANY_UNREACHABLE for a site that does not answer', async () => {
    const { repos, stored } = fakeRepos();
    const { deps, provider } = makeCaseHarness();
    const runner = createPipelineRunner({
      repos,
      config: { allowPrivateHosts: true, nodeEnv: 'test' },
      logger: logger(),
      createLlm: deps.createLlm,
      research: deps.research,
    });
    const err = (await failureOf(
      runner.run(job(await closedPortUrl()), context().ctx),
    )) as JobFailure;
    expect(err).toBeInstanceOf(JobFailure);
    expect(err.code).toBe('COMPANY_UNREACHABLE');
    expect(provider.calls).toHaveLength(0);
    expect(stored).toHaveLength(0);
  });

  it('maps quota and provider failures to stable codes with curated messages', async () => {
    const s = await site();
    const quota = makeCaseHarness({
      handlers: {
        'extract-requirements': () =>
          new LlmError('QUOTA_EXHAUSTED', { retryAfterMs: 2 * 3_600_000 }),
      },
    });
    const runner = createPipelineRunner({
      repos: fakeRepos().repos,
      config: { allowPrivateHosts: true, nodeEnv: 'test' },
      logger: logger(),
      createLlm: quota.deps.createLlm,
      research: quota.deps.research,
    });
    const err = (await failureOf(runner.run(job(s.url('/')), context().ctx))) as JobFailure;
    expect(err.code).toBe('LLM_QUOTA_EXHAUSTED');
    expect(err.message).toMatch(/resets in about 2 hours/);
  });

  it('fails with LLM_NOT_CONFIGURED when there is no key, without printing any value', async () => {
    const s = await site();
    const runner = createPipelineRunner({
      repos: fakeRepos().repos,
      config: { allowPrivateHosts: true, nodeEnv: 'test' },
      logger: logger(),
      env: { LLM_MODEL: 'some-model' },
    });
    const err = (await failureOf(runner.run(job(s.url('/')), context().ctx))) as JobFailure;
    expect(err).toBeInstanceOf(JobFailure);
    expect(err.code).toBe('LLM_NOT_CONFIGURED');
    expect(err.message).toMatch(/LLM_API_KEY/);
    expect(s.server.requests).toHaveLength(0); // checked before any research
  });

  it('reports invalid model settings as CONFIGURATION_ERROR and never echoes the key', async () => {
    const s = await site();
    const runner = createPipelineRunner({
      repos: fakeRepos().repos,
      config: { allowPrivateHosts: true, nodeEnv: 'test' },
      logger: logger(),
      env: { LLM_API_KEY: SECRET, LLM_MAX_RETRIES: 'many' },
    });
    const err = (await failureOf(runner.run(job(s.url('/')), context().ctx))) as JobFailure;
    expect(err.code).toBe('CONFIGURATION_ERROR');
    expect(JSON.stringify({ code: err.code, message: err.message })).not.toContain('SECRET');
  });

  it('lets an unexpected error escape as a non-JobFailure, so only the generic message is shown', async () => {
    const s = await site();
    const { deps } = makeCaseHarness();
    const runner = createPipelineRunner({
      repos: fakeRepos().repos,
      config: { allowPrivateHosts: true, nodeEnv: 'test' },
      logger: logger(),
      research: deps.research,
      createLlm: () => {
        throw new Error(`database exploded at mongodb://admin:${SECRET}@internal-host`);
      },
    });
    const err = await failureOf(runner.run(job(s.url('/')), context().ctx));
    expect(err).not.toBeInstanceOf(JobFailure);
  });

  it('logs gaps for the operator when the kit is incomplete, and still stores the kit', async () => {
    const s = await site();
    const { repos, stored } = fakeRepos();
    const log = logger();
    const { deps } = makeCaseHarness({
      handlers: { flashcards: () => new LlmError('RATE_LIMITED') },
    });
    const runner = createPipelineRunner({
      repos,
      config: { allowPrivateHosts: true, nodeEnv: 'test' },
      logger: log,
      createLlm: deps.createLlm,
      research: deps.research,
    });
    await runner.run(job(s.url('/')), context().ctx);
    expect(stored).toHaveLength(1);
    const warn = (log as unknown as { warn: ReturnType<typeof vi.fn> }).warn;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toMatch(/flashcards/);
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain('SECRET');
  });
});
