import { afterEach, describe, expect, it } from 'vitest';
import type { FetchError } from './errors.js';
import { createNetworkPolicy } from './network-policy.js';
import { createPoliteFetcher } from './polite-fetcher.js';
import { createSafeFetch } from './safe-fetch.js';
import { createFakeClock } from './test-support/fake-clock.js';
import {
  html,
  startServer,
  type RouteHandler,
  type TestServer,
} from './test-support/site-server.js';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function setup(routes: Record<string, RouteHandler>, deadlineOffsetMs?: number) {
  const s = await startServer(routes);
  servers.push(s);
  const clock = createFakeClock(0);
  const fetcher = createPoliteFetcher({
    safeFetch: createSafeFetch({
      userAgent: 'TestBot/1.0',
      policy: createNetworkPolicy({ loopbackHosts: [`site.test:${s.port}`] }),
      resolver: async () => ['127.0.0.1'],
      timeoutMs: 1000,
    }),
    clock,
    minIntervalMs: 500,
    retry: {
      maxRetries: 3,
      baseDelayMs: 200,
      maxDelayMs: 2000,
      maxRetryAfterMs: 5000,
      random: () => 1,
    },
    ...(deadlineOffsetMs === undefined ? {} : { deadline: deadlineOffsetMs }),
  });
  return { s, clock, fetcher, url: (p = '/') => `http://site.test:${s.port}${p}` };
}

describe('createPoliteFetcher', () => {
  it('spaces consecutive requests to one host', async () => {
    const { fetcher, clock, url, s } = await setup({
      '/a': html('a'),
      '/b': html('b'),
      '/c': html('c'),
    });
    await fetcher.fetch(url('/a'));
    await fetcher.fetch(url('/b'));
    await fetcher.fetch(url('/c'));
    expect(clock.sleeps).toEqual([500, 500]); // first request is free, then 500 ms between starts
    expect(s.requests).toHaveLength(3);
    expect(fetcher.stats.requests).toBe(3);
  });

  it('retries transient failures with backoff and returns the eventual success', async () => {
    const { fetcher, url, s } = await setup({
      '/flaky': (_req, hit) => (hit < 3 ? { status: 503, body: '' } : html('recovered')),
    });
    const res = await fetcher.fetch(url('/flaky'));
    expect(res.body).toBe('recovered');
    expect(s.requests).toHaveLength(3);
  });

  it('stops after the retry budget and reports the attempt count', async () => {
    const { fetcher, url, s } = await setup({ '/down': { status: 502, body: '' } });
    const err = (await fetcher.fetch(url('/down')).catch((e: unknown) => e)) as FetchError;
    expect(err.code).toBe('HTTP_ERROR');
    expect(err.status).toBe(502);
    expect(err.attempts).toBe(4);
    expect(s.requests).toHaveLength(4);
  });

  it('honours Retry-After on 429', async () => {
    const { fetcher, clock, url } = await setup({
      '/limited': (_req, hit) =>
        hit === 1 ? { status: 429, headers: { 'retry-after': '3' }, body: '' } : html('ok'),
    });
    await fetcher.fetch(url('/limited'));
    expect(clock.sleeps).toContain(3000);
  });

  it('does not retry a 404', async () => {
    const { fetcher, url, s } = await setup({});
    const err = (await fetcher.fetch(url('/missing')).catch((e: unknown) => e)) as FetchError;
    expect(err.status).toBe(404);
    expect(s.requests).toHaveLength(1);
  });

  it('refuses to start a request once the research deadline has passed', async () => {
    const { fetcher, url, s } = await setup({ '/a': html('a') }, 0);
    const err = (await fetcher.fetch(url('/a')).catch((e: unknown) => e)) as FetchError;
    expect(err.code).toBe('TIMEOUT');
    expect(s.requests).toHaveLength(0);
  });

  it('exposes a per-host interval override', async () => {
    const { fetcher, clock, url, s } = await setup({ '/a': html('a'), '/b': html('b') });
    fetcher.setMinInterval(`site.test:${s.port}`, 2000);
    await fetcher.fetch(url('/a'));
    await fetcher.fetch(url('/b'));
    expect(clock.sleeps).toEqual([2000]);
    expect(fetcher.getMinInterval(`site.test:${s.port}`)).toBe(2000);
  });
});
