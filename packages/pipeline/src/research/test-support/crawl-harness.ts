import { createNetworkPolicy } from '../network-policy.js';
import { createPoliteFetcher, type PoliteFetcher } from '../polite-fetcher.js';
import { createSafeFetch, type Resolver } from '../safe-fetch.js';
import { crawlCompanySite, type CrawlOptions } from '../crawler.js';
import type { CrawlResult } from '../types.js';
import { createFakeClock, type FakeClock } from './fake-clock.js';
import { startServer, type RouteHandler, type TestServer } from './site-server.js';

export interface Harness {
  server: TestServer;
  clock: FakeClock;
  fetcher: PoliteFetcher;
  /** http://acme.test:<port>/ — a hostname that resolves to the local fixture server. */
  rootUrl: string;
  url(path: string, host?: string): string;
  crawl(options?: CrawlOptions, rootUrl?: string): Promise<CrawlResult>;
  /** Paths the fixture server actually received, in order (query strings included). */
  paths(): string[];
}

export interface HarnessOptions {
  /** Host names that resolve to the fixture server. */
  hosts?: string[];
  fetchTimeoutMs?: number;
  minIntervalMs?: number;
  maxRetries?: number;
  /** Research deadline, relative to the start of the run. */
  deadlineMs?: number;
}

export async function makeHarness(
  routes: Record<string, RouteHandler>,
  options: HarnessOptions = {},
): Promise<Harness> {
  const server = await startServer(routes);
  const hosts = options.hosts ?? ['acme.test'];
  const clock = createFakeClock(0);

  const resolver: Resolver = async () => ['127.0.0.1'];
  const policy = createNetworkPolicy({
    loopbackHosts: [server.key, ...hosts.map((h) => `${h}:${server.port}`)],
  });
  const deadline = options.deadlineMs === undefined ? undefined : clock.now() + options.deadlineMs;
  const fetcher = createPoliteFetcher({
    safeFetch: createSafeFetch({
      userAgent: 'TraoPrepBot/0.1 (test)',
      policy,
      resolver,
      timeoutMs: options.fetchTimeoutMs ?? 1500,
    }),
    clock,
    minIntervalMs: options.minIntervalMs ?? 0,
    retry: {
      maxRetries: options.maxRetries ?? 3,
      baseDelayMs: 200,
      maxDelayMs: 2000,
      maxRetryAfterMs: 5000,
      random: () => 1,
    },
    ...(deadline === undefined ? {} : { deadline }),
  });

  const url = (path: string, host = hosts[0]!) => `http://${host}:${server.port}${path}`;
  return {
    server,
    clock,
    fetcher,
    rootUrl: url('/'),
    url,
    crawl: (crawlOptions, rootUrl = url('/')) =>
      crawlCompanySite(
        rootUrl,
        {
          fetcher,
          clock,
          policy,
          productToken: 'TraoPrepBot',
          ...(deadline === undefined ? {} : { deadline }),
        },
        crawlOptions,
      ),
    paths: () => server.requests.map((r) => r.path),
  };
}
