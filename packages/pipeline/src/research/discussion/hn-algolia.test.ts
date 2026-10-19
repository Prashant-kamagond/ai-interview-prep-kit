import { afterEach, describe, expect, it } from 'vitest';
import { createNetworkPolicy } from '../network-policy.js';
import { createPoliteFetcher } from '../polite-fetcher.js';
import { createSafeFetch } from '../safe-fetch.js';
import { createFakeClock, type FakeClock } from '../test-support/fake-clock.js';
import {
  startServer,
  type RouteHandler,
  type RouteResponse,
  type TestServer,
} from '../test-support/site-server.js';
import { createHnAlgoliaProvider, HN_ALGOLIA_BASE_URL } from './hn-algolia.js';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const json = (body: unknown, extra: Partial<RouteResponse> = {}): RouteResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json; charset=UTF-8' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
  ...extra,
});

function hit(id: number, over: Record<string, unknown> = {}) {
  return {
    objectID: String(id),
    author: 'someone',
    created_at: '2024-03-01T10:00:00Z',
    points: 12,
    story_id: id,
    title: null,
    story_title: 'Ask HN: interview experiences',
    story_text: null,
    comment_text: `I interviewed at Acme Rockets in 2023. The onsite had a system design round &amp; a values chat. (${id})`,
    _tags: ['comment', `story_${id}`],
    _highlightResult: { author: { value: 'x' } },
    ...over,
  };
}

async function setup(
  handler: RouteHandler,
  options: {
    fetchTimeoutMs?: number;
    maxRetries?: number;
    providerOptions?: Record<string, number>;
  } = {},
) {
  const server = await startServer({ '/api/v1/search': handler });
  servers.push(server);
  const clock: FakeClock = createFakeClock(Date.parse('2026-01-01T00:00:00Z'));
  const fetcher = createPoliteFetcher({
    safeFetch: createSafeFetch({
      userAgent: 'TraoPrepBot/0.1 (test)',
      policy: createNetworkPolicy({ loopbackHosts: [`hn.test:${server.port}`] }),
      resolver: async () => ['127.0.0.1'],
      timeoutMs: options.fetchTimeoutMs ?? 1500,
    }),
    clock,
    minIntervalMs: 1000,
    retry: {
      maxRetries: options.maxRetries ?? 2,
      baseDelayMs: 200,
      maxDelayMs: 2000,
      maxRetryAfterMs: 5000,
      random: () => 1,
    },
  });
  const provider = createHnAlgoliaProvider({
    fetch: fetcher.fetch,
    clock,
    baseUrl: `http://hn.test:${server.port}/api/v1`,
    ...options.providerOptions,
  });
  const queriesSeen = () =>
    server.requests.map((r) => new URL(r.path, 'http://x').searchParams.get('query'));
  return { server, clock, provider, queriesSeen };
}

describe('result shape', () => {
  it('returns real discussion URLs, titles, timestamps and short grounded snippets', async () => {
    const { provider, server } = await setup(() =>
      json({ hits: [hit(101), hit(102, { author: 'bob', points: null })] }),
    );
    const r = await provider.search({ company: 'Acme Rockets' });

    expect(r.provider).toBe('hn-algolia');
    expect(r.status).toBe('ok');
    expect(r.error).toBeNull();
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toEqual({
      url: 'https://news.ycombinator.com/item?id=101',
      source_id: '101',
      kind: 'comment',
      title: 'Ask HN: interview experiences',
      snippet: expect.stringContaining('I interviewed at Acme Rockets in 2023.'),
      author: 'someone',
      points: 12,
      created_at: '2024-03-01T10:00:00.000Z',
      matched_terms: expect.arrayContaining(['interviewed']),
      provenance: 'observed',
    });
    expect(r.items[1]).toMatchObject({ author: 'bob', points: null });
    expect(r.retrieved_at).toBe('2026-01-01T00:00:00.000Z');
    expect(r.items[0]!.snippet).not.toMatch(/&amp;|<|>/);
    expect(r.items[0]!.snippet).toContain('& a values chat');
    expect(server.requests.length).toBeGreaterThan(0);
  });

  it('treats stories and comments differently and uses only observed fields', async () => {
    const story = hit(7, {
      title: 'Acme Rockets interview process',
      story_title: null,
      comment_text: null,
      story_text: '',
      url: 'http://blog.example.com/acme-interview',
      _tags: ['story'],
    });
    const { provider } = await setup(() => json({ hits: [story] }));
    const r = await provider.search({ company: 'Acme Rockets' });
    expect(r.items[0]).toMatchObject({ kind: 'story', title: 'Acme Rockets interview process' });
    expect(JSON.stringify(r)).not.toMatch(/_highlightResult|objectID/);
  });

  it('sends a quoted, sanitised phrase query for stories and comments, with an honest User-Agent', async () => {
    const { provider, server, queriesSeen } = await setup(() => json({ hits: [hit(1)] }));
    await provider.search({ company: 'Ac"me\n Rockets' });
    expect(queriesSeen()[0]).toBe('"Acme Rockets" interview process');
    const url = new URL(server.requests[0]!.path, 'http://x');
    expect(url.pathname).toBe('/api/v1/search');
    expect(url.searchParams.get('tags')).toBe('(story,comment)');
    expect(Number(url.searchParams.get('hitsPerPage'))).toBeLessThanOrEqual(30);
    expect(server.requests[0]!.headers['user-agent']).toBe('TraoPrepBot/0.1 (test)');
    expect(server.requests[0]!.headers.cookie).toBeUndefined();
    expect(server.requests[0]!.headers.accept).toContain('application/json');
  });

  it('defaults to the official Hacker News Algolia endpoint and nothing else', () => {
    expect(HN_ALGOLIA_BASE_URL).toBe('https://hn.algolia.com/api/v1');
  });
});

describe('relevance and bounds', () => {
  it('drops hits that do not discuss interviewing at this company', async () => {
    const hits = [
      hit(1),
      hit(2, { comment_text: 'Acme Rockets shipped a new launch vehicle today.' }),
      hit(3, { comment_text: 'My interview at another company had a take-home.' }),
      hit(4, { comment_text: 'Acme Rockets is hiring engineers, apply on our site.' }),
      hit(5, { comment_text: 'The Acme Rocketsmith interview was fun.' }),
    ];
    const { provider } = await setup(() => json({ hits }));
    const r = await provider.search({ company: 'Acme Rockets' });
    expect(r.items.map((i) => i.source_id)).toEqual(['1']);
  });

  it('reports no_results honestly when nothing relevant exists, and never fabricates items', async () => {
    const { provider, queriesSeen } = await setup(() => json({ hits: [] }));
    const r = await provider.search({ company: 'Acme Rockets' });
    expect(r.status).toBe('no_results');
    expect(r.items).toEqual([]);
    expect(r.error).toBeNull();
    expect(r.limitations.join(' ')).toMatch(/no relevant/i);
    expect(queriesSeen()).toHaveLength(2); // the strict query, then one broader one
  });

  it('caps the number of results and never runs more than the allowed number of queries', async () => {
    const many = Array.from({ length: 25 }, (_, i) => hit(1000 + i));
    const { provider, server } = await setup(() => json({ hits: many }), {
      providerOptions: { maxItems: 8 },
    });
    const r = await provider.search({ company: 'Acme Rockets' });
    expect(r.items).toHaveLength(8);
    expect(server.requests).toHaveLength(1); // enough results from the first query, so no second one
  });

  it('removes duplicates across queries', async () => {
    const { provider } = await setup((req) => {
      const q = new URL(req.url!, 'http://x').searchParams.get('query')!;
      return json({ hits: q.endsWith('process') ? [hit(1), hit(2)] : [hit(2), hit(3)] });
    });
    const r = await provider.search({ company: 'Acme Rockets' });
    expect(r.items.map((i) => i.source_id)).toEqual(['1', '2', '3']);
  });

  it('spaces its requests at least one second apart', async () => {
    const { provider, clock } = await setup(() => json({ hits: [] }));
    await provider.search({ company: 'Acme Rockets' });
    expect(clock.sleeps).toContain(1000);
  });

  it('does not call the service without a usable company name', async () => {
    const { provider, server } = await setup(() => json({ hits: [hit(1)] }));
    for (const company of ['', '   ', '"', 'A']) {
      const r = await provider.search({ company });
      expect(r.status).toBe('no_results');
      expect(r.limitations.join(' ')).toMatch(/company name/i);
    }
    expect(server.requests).toHaveLength(0);
  });
});

describe('failures are reported, never fatal and never invented around', () => {
  it('flags a malformed body', async () => {
    for (const body of ['not json at all', '{"nope": 1}', '{"hits": "x"}', '[]', 'null']) {
      const { provider } = await setup(() => json(body));
      const r = await provider.search({ company: 'Acme Rockets' });
      expect(r.status, body).toBe('unavailable');
      expect(r.error?.code, body).toBe('MALFORMED_RESPONSE');
      expect(r.items).toEqual([]);
    }
  });

  it('skips individual malformed hits and keeps the valid ones', async () => {
    const { provider } = await setup(() =>
      json({ hits: [null, 5, 'x', { objectID: 123 }, { comment_text: 'no id' }, hit(9)] }),
    );
    const r = await provider.search({ company: 'Acme Rockets' });
    expect(r.status).toBe('ok');
    expect(r.items.map((i) => i.source_id)).toEqual(['9']);
  });

  it('rejects a non-JSON content type', async () => {
    const { provider } = await setup(() => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<html>',
    }));
    const r = await provider.search({ company: 'Acme Rockets' });
    expect(r.error?.code).toBe('MALFORMED_RESPONSE');
  });

  it('retries HTTP 429 with backoff, honours Retry-After, then reports RATE_LIMITED', async () => {
    const { provider, server, clock } = await setup(() => ({
      status: 429,
      headers: { 'retry-after': '2' },
      body: '',
    }));
    const r = await provider.search({ company: 'Acme Rockets' });
    expect(r.status).toBe('unavailable');
    expect(r.error?.code).toBe('RATE_LIMITED');
    expect(clock.sleeps).toContain(2000);
    // 1 attempt + 2 bounded retries for the first query, and then it stops: a service that said
    // "slow down" is not sent the follow-up query.
    expect(server.requests).toHaveLength(3);
    expect(r.queries).toHaveLength(1);
    expect(r.items).toEqual([]);
  });

  it('retries a transient 503 and then succeeds', async () => {
    const { provider } = await setup((_req, n) =>
      n === 1 ? { status: 503, body: '' } : json({ hits: [hit(1)] }),
    );
    const r = await provider.search({ company: 'Acme Rockets' });
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(1);
  });

  it.each([500, 502, 504])('reports HTTP %i as UPSTREAM_ERROR', async (status) => {
    const { provider } = await setup(() => ({ status, body: 'err' }));
    const r = await provider.search({ company: 'Acme Rockets' });
    expect(r.status).toBe('unavailable');
    expect(r.error?.code).toBe('UPSTREAM_ERROR');
  });

  it('reports a timeout', async () => {
    const { provider } = await setup(() => ({ hang: true }), {
      fetchTimeoutMs: 100,
      maxRetries: 0,
    });
    const r = await provider.search({ company: 'Acme Rockets' });
    expect(r.status).toBe('unavailable');
    expect(r.error?.code).toBe('TIMEOUT');
  });

  it('keeps results from a first query when the follow-up query fails, and says so', async () => {
    const { provider } = await setup((req, n) =>
      n === 1 ? json({ hits: [hit(1)] }) : { status: 500, body: '' },
    );
    const r = await provider.search({ company: 'Acme Rockets' });
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(1);
    expect(r.error).toBeNull();
    expect(r.limitations.join(' ')).toMatch(/follow-up query failed/i);
  });

  it('never leaks internal details in error messages', async () => {
    const { provider } = await setup(() => ({
      status: 500,
      body: 'stack trace at /srv/app.js mongodb://admin:pw@db',
    }));
    const r = await provider.search({ company: 'Acme Rockets' });
    expect(JSON.stringify(r)).not.toMatch(/stack trace|mongodb:|\/srv/);
  });
});
