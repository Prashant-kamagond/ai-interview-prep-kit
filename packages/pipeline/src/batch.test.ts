import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { batchOutputSchema, kitSchema } from '@trao/contracts';
import { validateKit } from '@trao/core';
import {
  BatchFatalError,
  DEFAULT_BATCH_DEADLINE_MS,
  readBatchInput,
  runBatch,
  writeBatchOutput,
} from './batch.js';
import { LlmError } from './llm/errors.js';
import { createFakeClock } from './research/test-support/fake-clock.js';
import { conventionalSite, noHiringSite } from './research/test-support/sites.js';
import { CaseFailure, type CaseInput, type CaseResult, type RunCaseDeps } from './run-case.js';
import { DETAILED_JD } from './stages/test-support/fixtures.js';
import {
  closedPortUrl,
  makeCaseHarness,
  startFixtureSite,
  type FixtureSite,
} from './test-support/case-harness.js';

const sites: FixtureSite[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function site(routes: Parameters<typeof startFixtureSite>[0]) {
  const s = await startFixtureSite(routes);
  sites.push(s);
  return s;
}
async function tempDir() {
  const d = await mkdtemp(join(tmpdir(), 'trao-batch-'));
  dirs.push(d);
  return d;
}

const aCase = (id: string, company_url: string, days = 5) => ({
  id,
  jd: DETAILED_JD,
  company_url,
  days,
});

/** A stand-in for runCase that returns a minimal valid result, for tests of the batch logic itself. */
function stubResult(): CaseResult {
  const kit = {
    source: {
      company: 'Acme',
      company_url: 'http://127.0.0.1/',
      role: 'Engineer',
      location: '',
      jd_chars: 1,
      researched_at: 'now',
      pages_used: [],
    },
    company_brief: { summary: '', what_they_do: '', sources: [] },
    role: { title: 'Engineer', seniority: '', responsibilities: [], requirements: [] },
    questions: [],
    flashcards: [],
    schedule: {
      days_available: 1,
      days: [{ day: 1, focus: 'Review', question_ids: [], minutes: 0 }],
    },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
  };
  return {
    kit,
    status: 'complete',
    incompleteReasons: [],
    limitations: [],
    warnings: [],
    research: {
      crawlStatus: 'ok',
      pagesFetched: 1,
      hiringPageFound: false,
      companyNameInferred: false,
    },
    stats: {} as CaseResult['stats'],
    timingsMs: {},
  };
}
const nullDeps = {} as RunCaseDeps;

describe('input handling', () => {
  it('rejects anything that is not an array, as a fatal error', async () => {
    for (const bad of [{}, 'x', 5, null]) {
      await expect(runBatch(bad, nullDeps)).rejects.toMatchObject({ code: 'INPUT_NOT_ARRAY' });
    }
  });

  it('records one failed entry per bad case and keeps going with the good ones', async () => {
    const ran: string[] = [];
    const run = async (c: CaseInput) => {
      ran.push(c.company_url);
      return stubResult();
    };
    const { output } = await runBatch(
      [
        aCase('good-1', 'http://127.0.0.1:9/'),
        { id: 'too-long', jd: 'x', company_url: 'http://127.0.0.1:9/', days: 61 },
        { id: 'zero', jd: 'x', company_url: 'http://127.0.0.1:9/', days: 0 },
        { id: 'fraction', jd: 'x', company_url: 'http://127.0.0.1:9/', days: 1.5 },
        { id: 'no-days', jd: 'x', company_url: 'http://127.0.0.1:9/' },
        { jd: 'x', company_url: 'http://127.0.0.1:9/', days: 3 },
        'not an object',
        { id: 'bad-url', jd: 'x', company_url: 'not a url', days: 2 },
        { id: 'empty-jd', jd: '  ', company_url: 'http://127.0.0.1:9/', days: 2 },
        aCase('good-2', 'http://127.0.0.1:9/', 60),
      ],
      nullDeps,
      { runCase: run },
    );
    expect(output.kits.map((k) => [k.id, k.status])).toEqual([
      ['good-1', 'ok'],
      ['too-long', 'failed'],
      ['zero', 'failed'],
      ['fraction', 'failed'],
      ['no-days', 'failed'],
      ['(entry 6)', 'failed'],
      ['(entry 7)', 'failed'],
      ['bad-url', 'failed'],
      ['empty-jd', 'failed'],
      ['good-2', 'ok'],
    ]);
    expect(ran).toHaveLength(2); // invalid cases never reach the pipeline
    const tooLong = output.kits[1]!;
    expect(tooLong.status === 'failed' && tooLong.error.code).toBe('INVALID_CASE');
    expect(tooLong.status === 'failed' && tooLong.error.message).toMatch(/between 1 and 60/);
  });

  it('keeps the first case with an id and fails later duplicates', async () => {
    const { output } = await runBatch(
      [aCase('same', 'http://127.0.0.1:9/'), aCase('same', 'http://127.0.0.1:9/')],
      nullDeps,
      { runCase: async () => stubResult() },
    );
    expect(output.kits.map((k) => k.status)).toEqual(['ok', 'failed']);
    const second = output.kits[1]!;
    expect(second.status === 'failed' && second.error.code).toBe('DUPLICATE_ID');
  });

  it('produces a valid empty output for an empty array', async () => {
    const { output, okCount, failedCount } = await runBatch([], nullDeps);
    expect(batchOutputSchema.safeParse(output).success).toBe(true);
    expect(output.kits).toEqual([]);
    expect([okCount, failedCount]).toEqual([0, 0]);
  });
});

describe('continuing after failures', () => {
  it('records a CaseFailure and runs every later case', async () => {
    const order: string[] = [];
    const run = async (c: CaseInput) => {
      order.push(c.company_url);
      if (c.company_url.includes('boom'))
        throw new CaseFailure('COMPANY_UNREACHABLE', 'Company site unreachable after 3 retries.');
      return stubResult();
    };
    const { output, reports } = await runBatch(
      [
        aCase('a', 'http://127.0.0.1:9/'),
        aCase('b', 'http://127.0.0.1:9/boom'),
        aCase('c', 'http://127.0.0.1:9/'),
      ],
      nullDeps,
      { runCase: run },
    );
    expect(output.kits.map((k) => k.status)).toEqual(['ok', 'failed', 'ok']);
    const b = output.kits[1]!;
    expect(b.status === 'failed' && b.error).toEqual({
      code: 'COMPANY_UNREACHABLE',
      message: 'Company site unreachable after 3 retries.',
    });
    expect(b.kit).toBeNull();
    expect(order).toHaveLength(3);
    expect(reports.map((r) => r.status)).toEqual(['ok', 'failed', 'ok']);
    expect(reports[1]).toMatchObject({ id: 'b', code: 'COMPANY_UNREACHABLE' });
  });

  it('turns an unexpected error into INTERNAL_ERROR without leaking its text', async () => {
    const state = { first: false };
    const { output } = await runBatch(
      [aCase('a', 'http://127.0.0.1:9/'), aCase('b', 'http://127.0.0.1:9/')],
      nullDeps,
      {
        runCase: async () => {
          if (!state.first) {
            state.first = true;
            throw new Error('connect ECONNREFUSED mongodb://admin:hunter2@internal-host:27017');
          }
          return stubResult();
        },
      },
    );
    expect(output.kits.map((k) => k.status)).toEqual(['failed', 'ok']);
    const a = output.kits[0]!;
    expect(a.status === 'failed' && a.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(output)).not.toMatch(/hunter2|mongodb|ECONNREFUSED/);
  });

  it('processes cases strictly one at a time, in input order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const started: string[] = [];
    const run = async (c: CaseInput) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      started.push(c.company_url);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return stubResult();
    };
    await runBatch(
      ['a', 'b', 'c', 'd'].map((id) => aCase(id, `http://127.0.0.1:9/${id}`)),
      nullDeps,
      { runCase: run },
    );
    expect(maxInFlight).toBe(1);
    expect(started).toEqual(['a', 'b', 'c', 'd'].map((id) => `http://127.0.0.1:9/${id}`));
  });
});

describe('deadlines', () => {
  it('fails the remaining cases with BATCH_DEADLINE_EXCEEDED once the batch budget is spent', async () => {
    const clock = createFakeClock(0);
    const calls: string[] = [];
    const run = async (c: CaseInput, deps: RunCaseDeps) => {
      calls.push(c.company_url);
      // Each case uses 40 s; the batch budget is 100 s, so the third case starts at 80 s, the fourth cannot.
      clock.advance(40_000);
      expect(deps.deadline).toBe(100_000);
      return stubResult();
    };
    const { output } = await runBatch(
      ['a', 'b', 'c', 'd', 'e'].map((id) => aCase(id, `http://127.0.0.1:9/${id}`)),
      { ...nullDeps, clock },
      { runCase: run, batchDeadlineMs: 100_000, clock },
    );
    expect(output.kits.map((k) => k.status)).toEqual(['ok', 'ok', 'ok', 'failed', 'failed']);
    const d = output.kits[3]!;
    expect(d.status === 'failed' && d.error.code).toBe('BATCH_DEADLINE_EXCEEDED');
    expect(calls).toHaveLength(3);
  });

  it('passes the per-case deadline setting to every case', async () => {
    const seen: (number | undefined)[] = [];
    await runBatch([aCase('a', 'http://127.0.0.1:9/')], nullDeps, {
      caseDeadlineMs: 12_345,
      runCase: async (_c, deps) => {
        seen.push(deps.caseDeadlineMs);
        return stubResult();
      },
    });
    expect(seen).toEqual([12_345]);
  });

  it('has a finite default batch deadline that leaves room for five 90-second cases', () => {
    expect(Number.isFinite(DEFAULT_BATCH_DEADLINE_MS)).toBe(true);
    expect(DEFAULT_BATCH_DEADLINE_MS).toBeGreaterThanOrEqual(5 * 90_000);
    expect(DEFAULT_BATCH_DEADLINE_MS).toBeLessThan(15 * 60_000);
  });
});

describe('the real pipeline over local fixture sites', () => {
  it('produces ok kits and honest failures in one run, with each case schedule length honoured', async () => {
    const good = await site(conventionalSite());
    const noHiring = await site(noHiringSite());
    const dead = await closedPortUrl();
    const { deps } = makeCaseHarness();
    const { output, okCount, failedCount, reports } = await runBatch(
      [
        aCase('case-01', good.url('/'), 5),
        aCase('case-02', dead, 3),
        aCase('case-03', noHiring.url('/'), 1),
        aCase('case-04', good.url('/'), 60),
        { id: 'case-05', jd: 'x', company_url: good.url('/'), days: 61 },
      ],
      deps,
    );
    expect(output.kits.map((k) => [k.id, k.status])).toEqual([
      ['case-01', 'ok'],
      ['case-02', 'failed'],
      ['case-03', 'ok'],
      ['case-04', 'ok'],
      ['case-05', 'failed'],
    ]);
    const failures = output.kits.flatMap((k) =>
      k.status === 'failed' ? [[k.id, k.error.code]] : [],
    );
    expect(failures).toEqual([
      ['case-02', 'COMPANY_UNREACHABLE'],
      ['case-05', 'INVALID_CASE'],
    ]);
    expect([okCount, failedCount]).toEqual([3, 2]);

    // Appendix B: the whole output validates, and every ok kit is a valid Appendix A kit.
    expect(batchOutputSchema.safeParse(output).success).toBe(true);
    for (const entry of output.kits) {
      if (entry.status !== 'ok') continue;
      expect(kitSchema.safeParse(entry.kit).success).toBe(true);
      const days = { 'case-01': 5, 'case-03': 1, 'case-04': 60 }[entry.id]!;
      expect(entry.kit.schedule.days).toHaveLength(days);
      expect(validateKit(entry.kit, { requestedDays: days }).ok).toBe(true);
    }
    expect(reports.map((r) => r.id)).toEqual([
      'case-01',
      'case-02',
      'case-03',
      'case-04',
      'case-05',
    ]);
  });

  it('keeps going and reports the limitation when a model stage fails in the middle of one case', async () => {
    const good = await site(conventionalSite());
    const { deps } = makeCaseHarness({
      handlers: { flashcards: () => new LlmError('RATE_LIMITED') },
    });
    const { output, reports } = await runBatch(
      [aCase('a', good.url('/')), aCase('b', good.url('/'))],
      deps,
    );
    expect(output.kits.map((k) => k.status)).toEqual(['ok', 'ok']);
    expect(reports[0]!.incompleteReasons.join(' ')).toMatch(/flashcards/);
    const a = output.kits[0]!;
    expect(a.status === 'ok' && a.kit.flashcards).toEqual([]);
  });

  it('records a quota failure for a case and still attempts the next one', async () => {
    const good = await site(conventionalSite());
    const { deps } = makeCaseHarness({
      handlers: {
        'extract-requirements': () => new LlmError('QUOTA_EXHAUSTED', { retryAfterMs: 3_600_000 }),
      },
    });
    const { output } = await runBatch([aCase('a', good.url('/')), aCase('b', good.url('/'))], deps);
    expect(output.kits.map((k) => (k.status === 'failed' ? k.error.code : 'ok'))).toEqual([
      'LLM_QUOTA_EXHAUSTED',
      'LLM_QUOTA_EXHAUSTED',
    ]);
  });

  it('gives the same kits for the same cases on a second run, apart from timestamps', async () => {
    const good = await site(conventionalSite());
    const cases = [aCase('a', good.url('/'), 4), aCase('b', good.url('/'), 2)];
    const strip = (o: Awaited<ReturnType<typeof runBatch>>['output']) =>
      JSON.parse(JSON.stringify({ ...o, generated_at: '' }), (k, v) =>
        k === 'researched_at' ? '' : v,
      );
    const one = await runBatch(cases, makeCaseHarness().deps);
    const two = await runBatch(cases, makeCaseHarness().deps);
    expect(strip(two.output)).toEqual(strip(one.output));
  });
});

describe('files', () => {
  it('reads a JSON file, tolerating a byte-order mark', async () => {
    const dir = await tempDir();
    const file = join(dir, 'cases.json');
    await writeFile(file, `\uFEFF${JSON.stringify([aCase('a', 'http://x.test/')])}`);
    expect(await readBatchInput(file)).toEqual([aCase('a', 'http://x.test/')]);
  });

  it('reports a missing file, a folder and invalid JSON as fatal input errors', async () => {
    const dir = await tempDir();
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{ not json');
    await expect(readBatchInput(join(dir, 'missing.json'))).rejects.toMatchObject({
      code: 'INPUT_UNREADABLE',
    });
    await expect(readBatchInput(dir)).rejects.toMatchObject({ code: 'INPUT_UNREADABLE' });
    await expect(readBatchInput(bad)).rejects.toMatchObject({ code: 'INPUT_INVALID_JSON' });
  });

  it('never puts a file path or system detail beyond a short reason in the error', async () => {
    const dir = await tempDir();
    const err = await readBatchInput(join(dir, 'secret-name.json')).catch(
      (e: unknown) => e as BatchFatalError,
    );
    expect(err).toBeInstanceOf(BatchFatalError);
    expect((err as BatchFatalError).message).not.toContain('secret-name');
  });

  it('writes a valid Appendix B file atomically and leaves no temporary file behind', async () => {
    const dir = await tempDir();
    const target = join(dir, 'nested', 'out', 'kits.json');
    const { output } = await runBatch([aCase('a', 'http://127.0.0.1:9/')], nullDeps, {
      runCase: async () => stubResult(),
    });
    await writeBatchOutput(target, output);
    const written = JSON.parse(await readFile(target, 'utf8')) as unknown;
    expect(batchOutputSchema.safeParse(written).success).toBe(true);
    expect((await readdir(join(dir, 'nested', 'out'))).sort()).toEqual(['kits.json']);
  });

  it('replaces an existing output file in one step', async () => {
    const dir = await tempDir();
    const target = join(dir, 'kits.json');
    await writeFile(target, 'OLD CONTENT');
    const { output } = await runBatch([], nullDeps);
    await writeBatchOutput(target, output);
    expect(JSON.parse(await readFile(target, 'utf8'))).toMatchObject({ version: '1.0', kits: [] });
  });

  it('refuses to write an output that breaks the contract', async () => {
    const dir = await tempDir();
    const target = join(dir, 'kits.json');
    const broken = {
      version: '1.0',
      generated_at: 'x',
      kits: [{ id: 'a', status: 'ok', kit: null, error: null }],
    };
    await expect(writeBatchOutput(target, broken as never)).rejects.toMatchObject({
      code: 'OUTPUT_INVALID',
    });
    await expect(readFile(target)).rejects.toThrow();
  });

  it('reports an unwritable destination as a fatal output error and cleans up', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'taken'));
    const { output } = await runBatch([], nullDeps);
    // The target path is an existing folder, so the final rename cannot succeed.
    await expect(writeBatchOutput(join(dir, 'taken'), output)).rejects.toMatchObject({
      code: 'OUTPUT_NOT_WRITABLE',
    });
    expect((await readdir(dir)).sort()).toEqual(['taken']);
  });
});
