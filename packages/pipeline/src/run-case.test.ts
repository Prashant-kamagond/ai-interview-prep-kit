import { afterEach, describe, expect, it } from 'vitest';
import { validateKit } from '@trao/core';
import { kitSchema } from '@trao/contracts';
import { LlmError } from './llm/errors.js';
import { createFakeClock } from './research/test-support/fake-clock.js';
import { conventionalSite, noHiringSite, relativeLinkSite } from './research/test-support/sites.js';
import { CaseFailure, runCase, type CaseInput } from './run-case.js';
import { DETAILED_JD, makeResearch } from './stages/test-support/fixtures.js';
import type { Clock } from './research/clock.js';
import type { ResearchConfig } from './research/research.js';
import {
  closedPortUrl,
  makeCaseHarness,
  startFixtureSite,
  type FixtureSite,
} from './test-support/case-harness.js';

const sites: FixtureSite[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
});
async function site(routes: Parameters<typeof startFixtureSite>[0]): Promise<FixtureSite> {
  const s = await startFixtureSite(routes);
  sites.push(s);
  return s;
}

const caseFor = (company_url: string, days = 5, jd = DETAILED_JD): CaseInput => ({
  jd,
  company_url,
  days,
});

async function failureOf(promise: Promise<unknown>): Promise<CaseFailure> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof CaseFailure) return err;
    throw err;
  }
  throw new Error('expected the case to fail');
}

describe('a successful case', () => {
  it('researches the local site, generates a kit and validates it against Appendix A', async () => {
    const s = await site(conventionalSite());
    const { deps, provider } = makeCaseHarness();
    const stages: [string, number][] = [];
    const out = await runCase(caseFor(s.url('/')), {
      ...deps,
      onProgress: (st, p) => void stages.push([st, p]),
    });

    expect(kitSchema.safeParse(out.kit).success).toBe(true);
    expect(validateKit(out.kit, { requestedDays: 5 }).ok).toBe(true);
    expect(out.status).toBe('complete');
    expect(out.kit.schedule.days).toHaveLength(5);
    expect(out.kit.schedule.days_available).toBe(5);
    expect(out.kit.source.company_url).toBe(s.url('/'));
    expect(out.kit.source.pages_used.length).toBeGreaterThan(0);
    expect(out.research.pagesFetched).toBeGreaterThan(0);
    expect(out.research.hiringPageFound).toBe(true);
    expect(provider.calls).toHaveLength(7); // one extraction, brief, four categories, flashcards
    expect(stages).toEqual([
      ['researching', 5],
      ['generating', 40],
      ['finalizing', 95],
    ]);
    expect(out.timingsMs.total).toBeGreaterThanOrEqual(out.timingsMs.research ?? 0);
  });

  it.each([1, 60])('builds a schedule of exactly %i day(s)', async (days) => {
    const s = await site(conventionalSite());
    const out = await runCase(caseFor(s.url('/'), days), makeCaseHarness().deps);
    expect(out.kit.schedule.days).toHaveLength(days);
    expect(out.kit.schedule.days_available).toBe(days);
    expect(validateKit(out.kit, { requestedDays: days }).ok).toBe(true);
  });

  it('gives stable ids and an identical kit for the same input and model replies', async () => {
    const s = await site(conventionalSite());
    const a = await runCase(caseFor(s.url('/')), makeCaseHarness().deps);
    const b = await runCase(caseFor(s.url('/')), makeCaseHarness().deps);
    const strip = (k: typeof a.kit) => ({ ...k, source: { ...k.source, researched_at: '' } });
    expect(strip(b.kit)).toEqual(strip(a.kit));
    expect(a.kit.role.requirements.map((r) => r.id)).toEqual([
      'r1',
      'r2',
      'r3',
      'r4',
      'r5',
      'r6',
      'r7',
      'r8',
    ]);
    expect(a.kit.questions.map((x) => x.id)).toEqual(a.kit.questions.map((_, i) => `q${i + 1}`));
    expect(a.kit.coverage.uncovered_requirement_ids).toEqual([]);
  });

  it('follows relative links on a site served from a sub-path', async () => {
    const s = await site(relativeLinkSite('/acme'));
    const out = await runCase(caseFor(s.url('/acme/')), makeCaseHarness().deps);
    expect(out.kit.source.pages_used.some((u) => u.endsWith('/acme/careers/'))).toBe(true);
    expect(out.research.hiringPageFound).toBe(true);
  });

  it('is still ok, and says so, when the site has no hiring page', async () => {
    const s = await site(noHiringSite());
    const out = await runCase(caseFor(s.url('/')), makeCaseHarness().deps);
    expect(out.research.hiringPageFound).toBe(false);
    expect(out.kit.source.pages_used.length).toBeGreaterThan(0);
    expect(out.limitations.join(' ')).toMatch(/hiring|interview/i);
  });

  it('infers the company name from the site and reports when it had to', async () => {
    const s = await site(conventionalSite());
    const out = await runCase(caseFor(s.url('/')), makeCaseHarness().deps);
    expect(out.research.companyNameInferred).toBe(true);
    expect(out.kit.source.company).not.toBe('');
  });
});

describe('invalid input', () => {
  it.each([
    ['days above 60', { days: 61 }],
    ['days of zero', { days: 0 }],
    ['fractional days', { days: 2.5 }],
    ['an empty description', { jd: '   ' }],
    ['a URL that is not http(s)', { company_url: 'ftp://example.com/' }],
    ['text that is not a URL', { company_url: 'not a url' }],
  ])('rejects %s before any research or model call', async (_label, patch) => {
    const s = await site(conventionalSite());
    const { deps, provider } = makeCaseHarness();
    const f = await failureOf(runCase({ ...caseFor(s.url('/')), ...patch }, deps));
    expect(f.code).toBe('INVALID_INPUT');
    expect(provider.calls).toHaveLength(0);
    expect(s.server.requests).toHaveLength(0);
  });
});

describe('company websites that cannot be researched', () => {
  it('fails with COMPANY_UNREACHABLE when nothing answers, and never calls the model', async () => {
    const { deps, provider } = makeCaseHarness();
    const f = await failureOf(runCase(caseFor(await closedPortUrl()), deps));
    expect(f.code).toBe('COMPANY_UNREACHABLE');
    expect(f.message).toMatch(/unreachable/i);
    expect(provider.calls).toHaveLength(0);
  });

  it('fails with COMPANY_UNREACHABLE when the site answers only 404', async () => {
    const s = await site({
      '/': { status: 404, body: 'nope' },
      '/robots.txt': { status: 404, body: '' },
    });
    const { deps, provider } = makeCaseHarness();
    const f = await failureOf(runCase(caseFor(s.url('/')), deps));
    expect(f.code).toBe('COMPANY_UNREACHABLE');
    expect(provider.calls).toHaveLength(0);
  });

  it('fails with COMPANY_BLOCKED_BY_ROBOTS when robots.txt forbids the whole site', async () => {
    const s = await site({
      '/robots.txt': {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: 'User-agent: *\nDisallow: /\n',
      },
      '/': {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<html><body>hello</body></html>',
      },
    });
    const { deps, provider } = makeCaseHarness();
    const f = await failureOf(runCase(caseFor(s.url('/')), deps));
    expect(f.code).toBe('COMPANY_BLOCKED_BY_ROBOTS');
    expect(provider.calls).toHaveLength(0);
    expect(s.server.requests.some((r) => r.path === '/')).toBe(false);
  });

  it('fails with COMPANY_URL_INVALID for a URL carrying credentials, without touching the network', async () => {
    const { deps, provider } = makeCaseHarness();
    const f = await failureOf(runCase(caseFor('http://user:pass@example.com/'), deps));
    expect(f.code).toBe('COMPANY_URL_INVALID');
    expect(provider.calls).toHaveLength(0);
    expect(f.message).not.toContain('pass');
  });
});

describe('SSRF protection', () => {
  it.each([
    ['a private address', 'http://10.0.0.5/'],
    ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
    ['a name that points at the local machine', 'http://localhost.localdomain/'],
  ])(
    'refuses %s with COMPANY_URL_BLOCKED, even with local fixtures enabled',
    async (_label, url) => {
      const { deps, provider } = makeCaseHarness({ allowLoopback: true });
      const f = await failureOf(runCase(caseFor(url), deps));
      expect(f.code).toBe('COMPANY_URL_BLOCKED');
      expect(provider.calls).toHaveLength(0);
    },
  );

  it('refuses loopback unless it was explicitly enabled', async () => {
    const s = await site(conventionalSite());
    const { deps } = makeCaseHarness({ allowLoopback: false });
    // The fixture's ephemeral port is already outside the permitted ports, so it is refused as invalid;
    // a loopback address on a permitted port is refused as blocked. Neither reaches the network.
    const onFixture = await failureOf(runCase(caseFor(s.url('/')), deps));
    expect(['COMPANY_URL_INVALID', 'COMPANY_URL_BLOCKED']).toContain(onFixture.code);
    expect(s.server.requests).toHaveLength(0);
    const onPort80 = await failureOf(runCase(caseFor('http://127.0.0.1/'), deps));
    expect(onPort80.code).toBe('COMPANY_URL_BLOCKED');
  });

  it('lets fixtures through only for the company URL itself, never for another local port', async () => {
    const a = await site(conventionalSite());
    const b = await site({
      '/': {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<html><body>SECRET internal service</body></html>',
      },
    });
    // The home page of A links to B on another port. B must never be fetched.
    const page = (href: string) => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: `<html><head><title>Evil</title></head><body><a href="${href}">careers jobs hiring</a><p>We are Evil Corp.</p></body></html>`,
    });
    const evil = await site({ '/': page(b.url('/')), '/robots.txt': { status: 404, body: '' } });
    const { deps } = makeCaseHarness({ allowLoopback: true });
    await runCase(caseFor(evil.url('/')), deps).catch(() => undefined);
    expect(b.server.requests).toHaveLength(0);
    expect(a.server.requests).toHaveLength(0);
  });

  it('refuses to enable loopback in production', async () => {
    const s = await site(conventionalSite());
    const { deps } = makeCaseHarness({ allowLoopback: true, nodeEnv: 'production' });
    const f = await failureOf(runCase(caseFor(s.url('/')), deps));
    expect(f.code).toBe('CONFIGURATION_ERROR');
    expect(s.server.requests).toHaveLength(0);
  });
});

describe('model failures', () => {
  const fail = (handlers: Parameters<typeof makeCaseHarness>[0]) => async () => {
    const s = await site(conventionalSite());
    return failureOf(runCase(caseFor(s.url('/')), makeCaseHarness(handlers).deps));
  };

  it('maps an authentication failure to LLM_AUTH_FAILED', async () => {
    const f = await fail({
      handlers: { 'extract-requirements': () => new LlmError('AUTH_FAILED') },
    })();
    expect(f.code).toBe('LLM_AUTH_FAILED');
  });

  it('maps a day-scale quota to LLM_QUOTA_EXHAUSTED and says when it resets', async () => {
    const f = await fail({
      handlers: {
        'extract-requirements': () =>
          new LlmError('QUOTA_EXHAUSTED', { retryAfterMs: 20 * 3_600_000 }),
      },
    })();
    expect(f.code).toBe('LLM_QUOTA_EXHAUSTED');
    expect(f.message).toMatch(/resets in about 20 hours/);
  });

  it('maps repeated provider timeouts to LLM_TIMEOUT', async () => {
    const f = await fail({ handlers: { 'extract-requirements': () => new LlmError('TIMEOUT') } })();
    expect(f.code).toBe('LLM_TIMEOUT');
  });

  it('maps an unavailable provider to LLM_UNAVAILABLE', async () => {
    const f = await fail({
      handlers: { 'extract-requirements': () => new LlmError('PROVIDER_UNAVAILABLE') },
    })();
    expect(f.code).toBe('LLM_UNAVAILABLE');
  });

  it('maps unusable model output to LLM_INVALID_OUTPUT', async () => {
    const f = await fail({ handlers: { 'extract-requirements': () => 'this is not json' } })();
    expect(f.code).toBe('LLM_INVALID_OUTPUT');
  });

  it('maps a missing key discovered while building the client to LLM_NOT_CONFIGURED', async () => {
    const s = await site(conventionalSite());
    const { deps } = makeCaseHarness();
    const f = await failureOf(
      runCase(caseFor(s.url('/')), {
        ...deps,
        createLlm: () => {
          throw new LlmError('MISSING_CREDENTIALS');
        },
      }),
    );
    expect(f.code).toBe('LLM_NOT_CONFIGURED');
  });

  it('never puts provider text, keys or prompts in the failure message', async () => {
    const f = await fail({
      handlers: {
        'extract-requirements': () =>
          new LlmError('PROVIDER_UNAVAILABLE', {
            detail: 'sk-SECRET-KEY-VALUE leaked from the provider',
          }),
      },
    })();
    expect(f.message).not.toMatch(/SECRET|sk-/);
    expect(JSON.stringify({ code: f.code, message: f.message })).not.toMatch(/SECRET/);
  });

  it('returns an honest, valid, incomplete kit when one category fails part-way', async () => {
    const s = await site(conventionalSite());
    const out = await runCase(
      caseFor(s.url('/')),
      makeCaseHarness({ handlers: { 'questions:technical': () => new LlmError('RATE_LIMITED') } })
        .deps,
    );
    expect(out.status).toBe('incomplete');
    expect(out.limitations.join(' ')).toMatch(/technical/i);
    expect(out.kit.coverage.uncovered_requirement_ids.length).toBeGreaterThan(0);
    expect(validateKit(out.kit, { requestedDays: 5 }).ok).toBe(true);
  });
});

describe('deadlines', () => {
  it('stops spending model calls once the case deadline passes and reports an incomplete kit', async () => {
    const s = await site(conventionalSite());
    const clock = createFakeClock(0);
    const { deps, provider } = makeCaseHarness({
      clock,
      caseDeadlineMs: 90_000,
      handlers: {
        // Extraction works, but takes the whole budget.
        'extract-requirements': () => {
          clock.advance(100_000);
          return {
            title: 'Senior Backend Engineer',
            seniority: 'Senior',
            location: 'Remote',
            company: 'Acme Payments',
            responsibilities: [],
            requirements: [
              {
                text: '5+ years with Node.js',
                quote: '5+ years of professional experience with Node.js',
                kind: 'technical',
                priority: 'must',
              },
            ],
          };
        },
      },
    });
    const out = await runCase(caseFor(s.url('/')), deps);
    expect(out.status).toBe('incomplete');
    expect(out.limitations.join(' ')).toMatch(/time budget/i);
    // Only the extraction call was made: nothing after the deadline.
    expect(provider.calls).toHaveLength(1);
    expect(validateKit(out.kit, { requestedDays: 5 }).ok).toBe(true);
  });

  it('fails with DEADLINE_EXCEEDED when the caller deadline has already passed', async () => {
    const s = await site(conventionalSite());
    const clock = createFakeClock(1000);
    const { deps, provider } = makeCaseHarness({ clock });
    const f = await failureOf(runCase(caseFor(s.url('/')), { ...deps, deadline: 1000 }));
    expect(f.code).toBe('DEADLINE_EXCEEDED');
    expect(provider.calls).toHaveLength(0);
    expect(s.server.requests).toHaveLength(0);
  });

  it('hands the model client the per-case deadline, never a later one', async () => {
    const s = await site(conventionalSite());
    const clock = createFakeClock(5000);
    const seen: number[] = [];
    const { deps } = makeCaseHarness({ clock, caseDeadlineMs: 90_000 });
    await runCase(caseFor(s.url('/')), {
      ...deps,
      deadline: 5000 + 30_000,
      createLlm: (args) => {
        seen.push(args.deadline);
        return deps.createLlm(args);
      },
    });
    expect(seen).toEqual([5000 + 30_000]); // the caller's tighter deadline wins over caseDeadlineMs
  });
});

describe('progress reporting', () => {
  it('ignores a progress callback that throws', async () => {
    const s = await site(conventionalSite());
    const out = await runCase(caseFor(s.url('/')), {
      ...makeCaseHarness().deps,
      onProgress: () => {
        throw new Error('observer broke');
      },
    });
    expect(out.status).toBe('complete');
  });
});

describe('the research budget', () => {
  /** Runs a case with a fake research function and returns the config it was given. */
  async function configSeenBy(
    over: Partial<Parameters<typeof runCase>[1]> = {},
    harness: Parameters<typeof makeCaseHarness>[0] = {},
  ): Promise<{ config: ResearchConfig; clock: Clock; llmDeadline: number }> {
    const clock = createFakeClock(5000);
    const { deps } = makeCaseHarness({ clock, ...harness });
    let config: ResearchConfig | undefined;
    let llmDeadline = Number.NaN;
    await runCase(caseFor('https://acme.test/'), {
      ...deps,
      createLlm: (args) => {
        llmDeadline = args.deadline;
        return deps.createLlm(args);
      },
      researchFn: async (_input, cfg) => {
        config = cfg;
        return makeResearch();
      },
      ...over,
    });
    if (!config) throw new Error('research was not called');
    return { config, clock, llmDeadline };
  }

  it('gives research 40% of the 90-second case budget: 36 seconds', async () => {
    const { config } = await configSeenBy();
    expect(config.totalTimeoutMs).toBe(36_000);
  });

  it.each([
    [50_000, 20_000],
    [10_000, 4_000],
    [90_001, 36_000], // rounded down
    [2_500, 1_000], // exactly the minimum
  ])(
    'derives the budget from the case deadline: %i ms case, %i ms research',
    async (caseDeadlineMs, expected) => {
      const { config } = await configSeenBy({ caseDeadlineMs });
      expect(config.totalTimeoutMs).toBe(expected);
    },
  );

  it.each([2_000, 1_000, 100])(
    'never gives research less than one second, even for a %i ms case (the minimum-budget edge)',
    async (caseDeadlineMs) => {
      const { config } = await configSeenBy({ caseDeadlineMs });
      expect(config.totalTimeoutMs).toBe(1_000);
      // The floor exceeds 40% of such a tiny budget: documented, bounded to one second.
      expect(config.totalTimeoutMs!).toBeGreaterThan(caseDeadlineMs * 0.4);
    },
  );

  it('honours a different research share', async () => {
    const { config } = await configSeenBy({ caseDeadlineMs: 80_000, researchShare: 0.25 });
    expect(config.totalTimeoutMs).toBe(20_000);
  });

  it('uses the time left when the caller (the batch) allows less than the case budget', async () => {
    // Clock starts at 5000; the caller's deadline is 10 s away, the case budget 90 s: 40% of 10 s.
    const { config } = await configSeenBy({ deadline: 5000 + 10_000 });
    expect(config.totalTimeoutMs).toBe(4_000);
  });

  it('keeps the model on the full case deadline, whatever research is given', async () => {
    const { llmDeadline } = await configSeenBy();
    expect(llmDeadline).toBe(5000 + 90_000);
  });

  it('passes the policy, the clock and the caller overrides through, and cannot be overridden on the budget', async () => {
    const { deps } = makeCaseHarness({ research: { minIntervalMs: 123 } });
    const clock = createFakeClock(0);
    let seen: ResearchConfig | undefined;
    await runCase(caseFor('https://acme.test/'), {
      ...deps,
      clock,
      // totalTimeoutMs is not part of the allowed overrides; even if one is smuggled in, the derived value wins.
      research: { ...deps.research, totalTimeoutMs: 1 } as never,
      researchFn: async (_i, cfg) => {
        seen = cfg;
        return makeResearch();
      },
    });
    expect(seen?.minIntervalMs).toBe(123);
    expect(seen?.clock).toBe(clock);
    expect(seen?.policy).toBeDefined();
    expect(seen?.totalTimeoutMs).toBe(36_000);
  });
});
