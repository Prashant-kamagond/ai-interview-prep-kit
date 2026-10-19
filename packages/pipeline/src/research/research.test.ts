import { afterEach, describe, expect, it } from 'vitest';
import type { DiscussionProvider } from './discussion/types.js';
import { createNetworkPolicy } from './network-policy.js';
import { createResearchPolicy, researchCompany, type ResearchConfig } from './research.js';
import { createFakeClock } from './test-support/fake-clock.js';
import {
  startServer,
  type RouteHandler,
  type RouteResponse,
  type TestServer,
} from './test-support/site-server.js';
import { conventionalSite, noHiringSite, page } from './test-support/sites.js';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const json = (body: unknown): RouteResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const hnHit = (id: number) => ({
  objectID: String(id),
  author: 'candidate',
  created_at: '2024-05-01T08:00:00Z',
  points: 3,
  story_title: 'Ask HN: interview experiences',
  comment_text: `I interviewed at Acme Rockets. It had a take-home and a system design round. (${id})`,
  _tags: ['comment'],
});

async function setup(
  routes: Record<string, RouteHandler>,
  overrides: Partial<ResearchConfig> = {},
) {
  const server = await startServer(routes);
  servers.push(server);
  const config: ResearchConfig = {
    policy: createNetworkPolicy({
      loopbackHosts: [`acme.test:${server.port}`, `hn.test:${server.port}`, server.key],
    }),
    resolver: async () => ['127.0.0.1'],
    clock: createFakeClock(Date.parse('2026-02-03T04:05:06Z')),
    minIntervalMs: 0,
    hnBaseUrl: `http://hn.test:${server.port}/api/v1`,
    ...overrides,
  };
  return { server, config, url: (p = '/') => `http://acme.test:${server.port}${p}` };
}

describe('researchCompany', () => {
  it('crawls the site, infers the company name, then searches Hacker News with it', async () => {
    const { server, config, url } = await setup({
      ...conventionalSite(),
      '/api/v1/search': () => json({ hits: [hnHit(1), hnHit(2)] }),
    });
    const r = await researchCompany({ companyUrl: url('/') }, config);

    expect(r.researched_at).toBe('2026-02-03T04:05:06.000Z');
    expect(r.company).toEqual({ name: 'Acme Rockets', name_source: 'title', inferred: true });
    expect(r.crawl.status).toBe('ok');
    expect(r.crawl.hiring.found).toBe(true);
    expect(r.pages_used).toEqual(r.crawl.pages.map((p) => p.url));
    expect(r.pages_used.some((u) => new URL(u).pathname === '/careers')).toBe(true);

    expect(r.discussion.status).toBe('ok');
    expect(r.discussion.queries[0]).toBe('"Acme Rockets" interview process');
    expect(r.discussion_urls).toEqual([
      'https://news.ycombinator.com/item?id=1',
      'https://news.ycombinator.com/item?id=2',
    ]);
    expect(r.limitations).toEqual([]);

    // Sequencing: the name comes from the crawl, so the search happens after it.
    const paths = server.requests.map((q) => q.path.split('?')[0]);
    expect(paths.indexOf('/api/v1/search')).toBeGreaterThan(paths.indexOf('/careers'));
  });

  it('uses a provided company name instead of inferring one', async () => {
    const { config, url } = await setup({
      ...conventionalSite(),
      '/api/v1/search': () => json({ hits: [hnHit(1)] }),
    });
    const r = await researchCompany({ companyUrl: url('/'), companyName: 'Acme Rockets' }, config);
    expect(r.company).toEqual({ name: 'Acme Rockets', name_source: 'provided', inferred: false });
  });

  it('still returns the crawl when discussion search is down, and records the limitation', async () => {
    const { config, url } = await setup({
      ...conventionalSite(),
      '/api/v1/search': () => ({ status: 500, body: '' }),
    });
    const r = await researchCompany({ companyUrl: url('/') }, config);
    expect(r.crawl.hiring.found).toBe(true);
    expect(r.discussion.status).toBe('unavailable');
    expect(r.discussion.error?.code).toBe('UPSTREAM_ERROR');
    expect(r.discussion_urls).toEqual([]);
    expect(r.limitations.join(' ')).toMatch(/could not be searched/i);
  });

  it('still searches discussion when the company site is unreachable, if the name is known', async () => {
    const { config, url, server } = await setup({
      '/api/v1/search': () => json({ hits: [hnHit(1)] }),
    });
    const r = await researchCompany({ companyUrl: url('/'), companyName: 'Acme Rockets' }, config);
    expect(r.crawl.status).toBe('unreachable');
    expect(r.pages_used).toEqual([]);
    expect(r.discussion.status).toBe('ok');
    expect(r.limitations.join(' ')).toMatch(/could not be retrieved/i);
    expect(server.requests.some((q) => q.path.startsWith('/api/v1/search'))).toBe(true);
  });

  it('skips the discussion search, saying why, when no company name can be determined', async () => {
    const { config, server } = await setup({
      '/robots.txt': { status: 404, body: '' },
      '/': page({
        title: 'Home',
        body: '<p>A page with no brand information at all, only generic words.</p>',
      }),
      '/api/v1/search': () => json({ hits: [hnHit(1)] }),
    });
    const r = await researchCompany({ companyUrl: `http://127.0.0.1:${server.port}/` }, config);
    expect(r.company).toEqual({ name: null, name_source: null, inferred: false });
    expect(r.discussion.status).toBe('no_results');
    expect(r.limitations.join(' ')).toMatch(/company name/i);
    expect(server.requests.some((q) => q.path.startsWith('/api/v1/search'))).toBe(false);
  });

  it('reports both gaps honestly when there is no hiring page and no public discussion', async () => {
    const { config, url } = await setup({
      ...noHiringSite(),
      '/api/v1/search': () => json({ hits: [] }),
    });
    const r = await researchCompany({ companyUrl: url('/'), companyName: 'Initech' }, config);
    expect(r.crawl.hiring.found).toBe(false);
    expect(r.discussion.status).toBe('no_results');
    expect(r.discussion.items).toEqual([]);
    const text = r.limitations.join(' ');
    expect(text).toMatch(/No hiring or careers page was found/);
    expect(text).toMatch(/No relevant Hacker News discussion/);
  });

  it('does not touch the network for a rejected company URL, and does not throw', async () => {
    const { config, server } = await setup({ '/api/v1/search': () => json({ hits: [hnHit(1)] }) });
    const r = await researchCompany({ companyUrl: 'http://10.0.0.1/' }, config);
    expect(r.crawl.status).toBe('rejected');
    expect(r.company.name).toBeNull();
    expect(server.requests).toHaveLength(0);
  });

  it('accepts any discussion provider through the interface', async () => {
    const seen: string[] = [];
    const stub: DiscussionProvider = {
      id: 'stub',
      async search({ company }) {
        seen.push(company);
        return {
          provider: 'stub',
          status: 'no_results',
          items: [],
          queries: [],
          retrieved_at: 'x',
          error: null,
          limitations: [],
        };
      },
    };
    const { config, url, server } = await setup(conventionalSite(), { discussionProvider: stub });
    const r = await researchCompany({ companyUrl: url('/') }, config);
    expect(seen).toEqual(['Acme Rockets']);
    expect(r.discussion.provider).toBe('stub');
    expect(server.requests.some((q) => q.path.startsWith('/api/v1/search'))).toBe(false);
  });

  it('keeps the whole result serialisable', async () => {
    const { config, url } = await setup({
      ...conventionalSite(),
      '/api/v1/search': () => json({ hits: [hnHit(1)] }),
    });
    const r = await researchCompany({ companyUrl: url('/') }, config);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

describe('createResearchPolicy (loopback fixtures for development and batch only)', () => {
  it('allows loopback for exactly the case’s own host and port when explicitly enabled', () => {
    const policy = createResearchPolicy({
      companyUrl: 'http://localhost:8099/acme/',
      allowLoopback: true,
      nodeEnv: 'development',
    });
    expect([...policy.loopbackHosts]).toEqual(['localhost:8099']);
  });

  it('is strict by default', () => {
    const policy = createResearchPolicy({
      companyUrl: 'http://localhost:8099/acme/',
      allowLoopback: false,
      nodeEnv: 'development',
    });
    expect(policy.loopbackHosts.size).toBe(0);
  });

  it('does nothing for a company URL that is not on loopback, even when enabled', () => {
    for (const companyUrl of [
      'https://acme.com/',
      'http://10.0.0.5:8099/',
      'http://192.168.1.2/',
      'not a url',
    ]) {
      const policy = createResearchPolicy({
        companyUrl,
        allowLoopback: true,
        nodeEnv: 'development',
      });
      expect(policy.loopbackHosts.size, companyUrl).toBe(0);
    }
  });

  it('refuses outright in production', () => {
    expect(() =>
      createResearchPolicy({
        companyUrl: 'http://127.0.0.1:8099/',
        allowLoopback: true,
        nodeEnv: 'production',
      }),
    ).toThrow(/production/i);
    expect(() =>
      createResearchPolicy({
        companyUrl: 'https://acme.com/',
        allowLoopback: false,
        nodeEnv: 'production',
      }),
    ).not.toThrow();
  });

  it('treats the whole 127.0.0.0/8 block and ::1 as loopback', () => {
    for (const companyUrl of [
      'http://127.0.0.1:8099/',
      'http://127.5.5.5:8099/',
      'http://[::1]:8099/',
    ]) {
      const policy = createResearchPolicy({ companyUrl, allowLoopback: true, nodeEnv: 'test' });
      expect(policy.loopbackHosts.size, companyUrl).toBe(1);
    }
  });
});
