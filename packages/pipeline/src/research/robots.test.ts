import { afterEach, describe, expect, it } from 'vitest';
import { createNetworkPolicy } from './network-policy.js';
import { createPoliteFetcher } from './polite-fetcher.js';
import { loadRobots, parseRobots } from './robots.js';
import { createSafeFetch, type Resolver } from './safe-fetch.js';
import { createFakeClock } from './test-support/fake-clock.js';
import {
  html,
  redirect,
  startServer,
  text,
  type RouteHandler,
  type TestServer,
} from './test-support/site-server.js';

const TOKEN = 'TestBot';

describe('parseRobots', () => {
  it('allows everything when there are no rules', () => {
    expect(parseRobots('', TOKEN).allows('/anything')).toBe(true);
    expect(parseRobots('# just a comment\n', TOKEN).allows('/x')).toBe(true);
  });

  it('applies Disallow as a path prefix', () => {
    const r = parseRobots('User-agent: *\nDisallow: /private', TOKEN);
    expect(r.allows('/private')).toBe(false);
    expect(r.allows('/private/page')).toBe(false);
    expect(r.allows('/privateer')).toBe(false); // prefix match, per the standard
    expect(r.allows('/public')).toBe(true);
  });

  it('treats an empty Disallow as allow-all and "Disallow: /" as block-all', () => {
    expect(parseRobots('User-agent: *\nDisallow:', TOKEN).allows('/x')).toBe(true);
    expect(parseRobots('User-agent: *\nDisallow: /', TOKEN).allows('/x')).toBe(false);
    expect(parseRobots('User-agent: *\nDisallow: /', TOKEN).allows('/')).toBe(false);
  });

  it('lets the longest matching rule win, and Allow win a tie', () => {
    const longer = parseRobots('User-agent: *\nDisallow: /a/\nAllow: /a/public/', TOKEN);
    expect(longer.allows('/a/secret')).toBe(false);
    expect(longer.allows('/a/public/x')).toBe(true);

    const tie = parseRobots('User-agent: *\nDisallow: /x\nAllow: /x', TOKEN);
    expect(tie.allows('/x')).toBe(true);

    const shorterAllow = parseRobots('User-agent: *\nAllow: /a\nDisallow: /a/b', TOKEN);
    expect(shorterAllow.allows('/a/b/c')).toBe(false);
    expect(shorterAllow.allows('/a/other')).toBe(true);
  });

  it('supports * wildcards and the $ end anchor', () => {
    const r = parseRobots(
      'User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp/*/cache\nDisallow: /*?session=',
      TOKEN,
    );
    expect(r.allows('/files/report.pdf')).toBe(false);
    expect(r.allows('/files/report.pdf.html')).toBe(true); // $ anchors the end
    expect(r.allows('/tmp/x/cache')).toBe(false);
    expect(r.allows('/tmp/x/other')).toBe(true);
    expect(r.allows('/page?session=abc')).toBe(false);
    expect(r.allows('/page?other=1')).toBe(true);
  });

  it('prefers the group for our own product token over the * group', () => {
    const text = 'User-agent: *\nDisallow: /\n\nUser-agent: TestBot\nDisallow: /secret\n';
    const r = parseRobots(text, TOKEN);
    expect(r.allows('/careers')).toBe(true);
    expect(r.allows('/secret/x')).toBe(false);
  });

  it('falls back to the * group when no group names us', () => {
    const r = parseRobots(
      'User-agent: OtherBot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin\n',
      TOKEN,
    );
    expect(r.allows('/careers')).toBe(true);
    expect(r.allows('/admin')).toBe(false);
  });

  it('merges stacked User-agent lines into one group and repeated groups for one agent', () => {
    const stacked = parseRobots('User-agent: A\nUser-agent: TestBot\nDisallow: /x\n', TOKEN);
    expect(stacked.allows('/x')).toBe(false);
    const repeated = parseRobots(
      'User-agent: TestBot\nDisallow: /a\n\nUser-agent: TestBot\nDisallow: /b\n',
      TOKEN,
    );
    expect(repeated.allows('/a')).toBe(false);
    expect(repeated.allows('/b')).toBe(false);
  });

  it('is tolerant: case-insensitive names, comments, CRLF, BOM, spacing, ignored rules before any group', () => {
    const messy =
      '﻿Disallow: /ignored-before-any-group\r\n' +
      'USER-AGENT:   testbot   # us\r\n' +
      'dIsAlLoW :/Secret # note\r\n' +
      'Sitemap: https://example.com/sitemap.xml\r\n';
    const r = parseRobots(messy, TOKEN);
    expect(r.allows('/ignored-before-any-group')).toBe(true);
    expect(r.allows('/Secret/x')).toBe(false);
    expect(r.allows('/secret')).toBe(true); // paths are case-sensitive
  });

  it('matches against path plus query string', () => {
    const r = parseRobots('User-agent: *\nDisallow: /search?', TOKEN);
    expect(r.allows('/search?q=jobs')).toBe(false);
    expect(r.allows('/search')).toBe(true);
  });

  it('reads Crawl-delay for the matching group only', () => {
    expect(parseRobots('User-agent: *\nCrawl-delay: 2', TOKEN).crawlDelayMs).toBe(2000);
    expect(parseRobots('User-agent: *\nCrawl-delay: 0.5', TOKEN).crawlDelayMs).toBe(500);
    expect(
      parseRobots('User-agent: *\nCrawl-delay: 10\n\nUser-agent: TestBot\nCrawl-delay: 1', TOKEN)
        .crawlDelayMs,
    ).toBe(1000);
    expect(parseRobots('User-agent: *\nCrawl-delay: soon', TOKEN).crawlDelayMs).toBeNull();
    expect(parseRobots('User-agent: *\nCrawl-delay: -3', TOKEN).crawlDelayMs).toBeNull();
    expect(parseRobots('User-agent: OtherBot\nCrawl-delay: 9', TOKEN).crawlDelayMs).toBeNull();
  });
});

describe('loadRobots', () => {
  const servers: TestServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  async function setup(routes: Record<string, RouteHandler>) {
    const s = await startServer(routes);
    servers.push(s);
    const resolver: Resolver = async () => ['127.0.0.1'];
    const clock = createFakeClock();
    const safeFetch = createSafeFetch({
      userAgent: 'TestBot/1.0',
      policy: createNetworkPolicy({ loopbackHosts: [`site.test:${s.port}`] }),
      resolver,
      timeoutMs: 1000,
      redirectGuard: (from, to) => from.host === to.host,
    });
    const fetcher = createPoliteFetcher({
      safeFetch,
      clock,
      minIntervalMs: 0,
      retry: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1000, maxRetryAfterMs: 2000 },
    });
    const origin = new URL(`http://site.test:${s.port}/`);
    return {
      s,
      fetcher,
      clock,
      load: () => loadRobots({ origin, fetch: fetcher.fetch, productToken: TOKEN }),
    };
  }

  it('fetches and parses /robots.txt', async () => {
    const { load, s } = await setup({
      '/robots.txt': text('User-agent: *\nDisallow: /private\nCrawl-delay: 1'),
    });
    const info = await load();
    expect(info.status).toBe('found');
    expect(info.rules.allows('/private')).toBe(false);
    expect(info.rules.allows('/careers')).toBe(true);
    expect(info.rules.crawlDelayMs).toBe(1000);
    expect(info.limitation).toBeNull();
    expect(s.requests.map((r) => r.path)).toEqual(['/robots.txt']);
  });

  it.each([404, 410, 403, 401])(
    'treats HTTP %i as "no robots.txt": nothing is restricted',
    async (status) => {
      const { load } = await setup({ '/robots.txt': { status, body: 'nope' } });
      const info = await load();
      expect(info.status).toBe('not-found');
      expect(info.rules.allows('/anything')).toBe(true);
      expect(info.limitation).toBeNull();
    },
  );

  it('is conservative when robots.txt cannot be retrieved: nothing may be crawled, and it says so', async () => {
    const { load, s } = await setup({ '/robots.txt': { status: 500, body: 'boom' } });
    const info = await load();
    expect(info.status).toBe('unreachable');
    expect(info.rules.allows('/')).toBe(false);
    expect(info.rules.allows('/careers')).toBe(false);
    expect(info.limitation).toMatch(/robots\.txt/i);
    expect(s.requests).toHaveLength(3); // 1 attempt + 2 bounded retries
  });

  it('retries a transient failure and then uses the real rules', async () => {
    const { load } = await setup({
      '/robots.txt': (_req, hit) =>
        hit === 1 ? { status: 503, body: '' } : text('User-agent: *\nDisallow: /x'),
    });
    const info = await load();
    expect(info.status).toBe('found');
    expect(info.rules.allows('/x')).toBe(false);
  });

  it('treats a timeout as unreachable', async () => {
    const { load } = await setup({ '/robots.txt': { hang: true } });
    // shorten the fetch timeout by using a tighter safeFetch
    const s = servers[0]!;
    const fetcher = createPoliteFetcher({
      safeFetch: createSafeFetch({
        userAgent: 'TestBot/1.0',
        policy: createNetworkPolicy({ loopbackHosts: [`site.test:${s.port}`] }),
        resolver: async () => ['127.0.0.1'],
        timeoutMs: 100,
      }),
      clock: createFakeClock(),
      minIntervalMs: 0,
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 1 },
    });
    const info = await loadRobots({
      origin: new URL(`http://site.test:${s.port}/`),
      fetch: fetcher.fetch,
      productToken: TOKEN,
    });
    expect(info.status).toBe('unreachable');
    expect(info.rules.allows('/')).toBe(false);
    void load;
  });

  it('treats a soft-404 HTML page served as robots.txt as having no rules', async () => {
    const { load } = await setup({ '/robots.txt': html('<h1>Page not found</h1>') });
    const info = await load();
    expect(info.rules.allows('/careers')).toBe(true);
  });

  it('follows a same-site redirect for robots.txt but is conservative about a cross-site one', async () => {
    const same = await setup({
      '/robots.txt': redirect('/real-robots.txt'),
      '/real-robots.txt': text('User-agent: *\nDisallow: /blocked'),
    });
    const sameInfo = await same.load();
    expect(sameInfo.rules.allows('/blocked')).toBe(false);

    const cross = await setup({ '/robots.txt': redirect('http://elsewhere.test/robots.txt') });
    const crossInfo = await cross.load();
    expect(crossInfo.status).toBe('unreachable');
    expect(crossInfo.rules.allows('/')).toBe(false);
  });

  it('applies the site Crawl-delay to the host schedule', async () => {
    const { load, fetcher, s } = await setup({
      '/robots.txt': text('User-agent: *\nCrawl-delay: 2'),
    });
    const info = await load();
    expect(info.rules.crawlDelayMs).toBe(2000);
    expect(fetcher.getMinInterval(`site.test:${s.port}`)).toBeUndefined(); // set by the crawler, not by loadRobots
  });
});
