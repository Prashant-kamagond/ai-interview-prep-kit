import { isIP } from 'node:net';
import { systemClock, type Clock } from './clock.js';
import { inferCompanyName, type CompanyNameSource } from './company-name.js';
import { crawlCompanySite, type CrawlOptions } from './crawler.js';
import { createHnAlgoliaProvider, HN_ALGOLIA_BASE_URL } from './discussion/hn-algolia.js';
import type { DiscussionProvider, DiscussionResult } from './discussion/types.js';
import { classifyIp } from './ip-policy.js';
import {
  bareHostname,
  createNetworkPolicy,
  hostKey,
  type NetworkPolicy,
} from './network-policy.js';
import { createPoliteFetcher } from './polite-fetcher.js';
import type { RetryOptions } from './retry.js';
import { createSafeFetch, type Resolver } from './safe-fetch.js';
import type { CrawlResult } from './types.js';

export const PRODUCT_TOKEN = 'TraoPrepBot';
export const DEFAULT_USER_AGENT = `${PRODUCT_TOKEN}/0.1 (interview-preparation research; honours robots.txt)`;

const DEFAULT_TOTAL_TIMEOUT_MS = 90_000;
const CRAWL_SHARE_OF_BUDGET = 0.8; // the rest is kept for the discussion search
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_INTERVAL_MS = 1000;
const DEFAULT_RETRY: Omit<RetryOptions, 'clock' | 'deadline'> = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  maxRetryAfterMs: 10_000,
};

/**
 * The policy a research run uses. Strict unless `allowLoopback` is set; when it is, loopback is
 * permitted for exactly the host:port of the company URL itself (the local fixture site of a
 * batch case), and only if that URL really is on loopback. It never unlocks private ranges,
 * metadata addresses or other ports, and it throws in production.
 */
export function createResearchPolicy(args: {
  companyUrl: string;
  allowLoopback: boolean;
  nodeEnv?: string | undefined;
}): NetworkPolicy {
  let loopbackHosts: string[] = [];
  if (args.allowLoopback) {
    try {
      const url = new URL(args.companyUrl);
      const host = bareHostname(url);
      const loopback =
        host === 'localhost' || (isIP(host) !== 0 && classifyIp(host) === 'loopback');
      if (loopback) loopbackHosts = [hostKey(url)];
    } catch {
      // not a URL: nothing to allow; the crawler will reject it
    }
  }
  return createNetworkPolicy({ loopbackHosts, nodeEnv: args.nodeEnv });
}

export interface ResearchConfig {
  policy: NetworkPolicy;
  userAgent?: string;
  productToken?: string;
  resolver?: Resolver;
  clock?: Clock;
  /** Everything (crawl and discussion search) must finish within this many milliseconds. */
  totalTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Minimum gap between requests to one host. */
  minIntervalMs?: number;
  retry?: Omit<RetryOptions, 'clock' | 'deadline'>;
  crawl?: CrawlOptions;
  /** Replaces the Hacker News provider entirely. */
  discussionProvider?: DiscussionProvider;
  /** Override for the Hacker News API base URL (tests only). */
  hnBaseUrl?: string;
}

export interface ResearchInput {
  companyUrl: string;
  /** If omitted, a name is inferred from the site and marked as inferred. */
  companyName?: string;
}

export interface ResearchResult {
  researched_at: string;
  company: {
    name: string | null;
    name_source: CompanyNameSource | 'provided' | null;
    /** True when the name was worked out from the site rather than supplied. */
    inferred: boolean;
  };
  crawl: CrawlResult;
  discussion: DiscussionResult;
  /** URLs of the company pages that were actually fetched and used (Appendix A `pages_used`). */
  pages_used: string[];
  /** URLs of public discussions found. Kept separate from company pages. */
  discussion_urls: string[];
  /** Everything that could not be done or found, in plain language. */
  limitations: string[];
}

/**
 * Runs the research stage for one company: crawl the site, work out the company name, search
 * public discussion. Failures of any source are reported in the result; this function does not
 * throw because a site is down, blocked, empty or hostile.
 */
export async function researchCompany(
  input: ResearchInput,
  config: ResearchConfig,
): Promise<ResearchResult> {
  const clock = config.clock ?? systemClock;
  const startedAt = clock.now();
  const total = config.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
  const productToken = config.productToken ?? PRODUCT_TOKEN;
  const retry = config.retry ?? DEFAULT_RETRY;
  const minIntervalMs = config.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

  const safeFetch = createSafeFetch({
    userAgent,
    policy: config.policy,
    timeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    ...(config.resolver ? { resolver: config.resolver } : {}),
  });
  const makeFetcher = (deadline: number) =>
    createPoliteFetcher({ safeFetch, clock, minIntervalMs, retry, deadline });

  // 1. The company site.
  const crawlDeadline = startedAt + Math.floor(total * CRAWL_SHARE_OF_BUDGET);
  const crawl = await crawlCompanySite(
    input.companyUrl,
    {
      fetcher: makeFetcher(crawlDeadline),
      clock,
      policy: config.policy,
      productToken,
      deadline: crawlDeadline,
    },
    config.crawl,
  );

  // 2. The company name: given, or inferred from what the crawl saw.
  const limitations = [...crawl.limitations];
  let company: ResearchResult['company'] = { name: null, name_source: null, inferred: false };
  if (input.companyName && input.companyName.trim() !== '') {
    company = { name: input.companyName.trim(), name_source: 'provided', inferred: false };
  } else if (crawl.status !== 'rejected') {
    try {
      const home = crawl.pages[0];
      const inferred = inferCompanyName(
        new URL(input.companyUrl),
        home ? { title: home.title, siteName: null } : null,
      );
      if (inferred) company = { name: inferred.name, name_source: inferred.source, inferred: true };
    } catch {
      // an unparsable URL has no name to infer
    }
  }

  // 3. Public discussion of the interview process.
  const provider: DiscussionProvider =
    config.discussionProvider ??
    createHnAlgoliaProvider({
      fetch: makeFetcher(startedAt + total).fetch,
      clock,
      baseUrl: config.hnBaseUrl ?? HN_ALGOLIA_BASE_URL,
    });

  let discussion: DiscussionResult;
  if (company.name) {
    discussion = await provider.search({ company: company.name });
  } else {
    discussion = {
      provider: provider.id,
      status: 'no_results',
      items: [],
      queries: [],
      retrieved_at: new Date(clock.now()).toISOString(),
      error: null,
      limitations: [],
    };
    limitations.push('No company name could be determined, so public discussion was not searched.');
  }
  limitations.push(...discussion.limitations);

  return {
    researched_at: new Date(startedAt).toISOString(),
    company,
    crawl,
    discussion,
    pages_used: crawl.pages.map((p) => p.url),
    discussion_urls: discussion.items.map((i) => i.url),
    limitations,
  };
}
