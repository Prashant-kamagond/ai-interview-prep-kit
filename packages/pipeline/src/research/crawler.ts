import type { Clock } from './clock.js';
import { fingerprint, ContentDeduper } from './dedupe.js';
import { FetchError } from './errors.js';
import { classifyPage } from './hiring.js';
import { extractPage } from './html.js';
import { rankLinks } from './link-ranking.js';
import { hostKey, validateUrl, type NetworkPolicy } from './network-policy.js';
import { RESEARCH_BUDGET_MESSAGE, type PoliteFetcher } from './polite-fetcher.js';
import { loadRobots, type RobotsInfo } from './robots.js';
import type {
  CrawlResult,
  CrawlStatus,
  RobotsSummary,
  SkippedSource,
  SourceFailure,
  SourcePage,
} from './types.js';
import { createScope, urlKey, type Scope } from './url-utils.js';

export interface CrawlDeps {
  fetcher: PoliteFetcher;
  clock: Clock;
  policy: NetworkPolicy;
  /** Our robots.txt product token, e.g. "TraoPrepBot". */
  productToken: string;
  /** Absolute time (clock scale) after which no new page is started. */
  deadline?: number;
}

export interface CrawlOptions {
  /** Most pages attempted (successes and failures), excluding robots.txt files. */
  maxPages?: number;
  /** Most links deep from the company URL. */
  maxDepth?: number;
  /** Pages larger than this are read only in part (and marked truncated), never rejected. */
  maxPageBytes?: number;
}

const DEFAULT_MAX_PAGES = 12;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_PAGE_BYTES = 3_000_000; // real homepages routinely exceed 1 MB of HTML
const DEPTH_PENALTY = 0.25;

interface Candidate {
  url: URL;
  key: string;
  score: number;
  depth: number;
}

const priority = (c: Candidate) => c.score - DEPTH_PENALTY * c.depth;
const pathAndQuery = (url: URL) => `${url.pathname}${url.search}`;

function toFailure(url: string, err: unknown): SourceFailure {
  if (err instanceof FetchError) {
    return {
      url,
      code: err.code,
      message: err.message,
      ...(err.status === undefined ? {} : { status: err.status }),
      attempts: err.attempts,
    };
  }
  return {
    url,
    code: 'NETWORK_ERROR',
    message: 'An unexpected error occurred while fetching',
    attempts: 1,
  };
}

/**
 * Crawls one company site for what the company does and, if it exists, how it hires.
 *
 * Order of work: validate the URL, read robots.txt, fetch the company URL, then repeatedly fetch
 * the highest-ranked unfetched link until the page, depth or time budget is spent. Links come from
 * the pages themselves (nothing is guessed from a fixed list of paths), are scored by
 * deterministic heuristics, and must stay inside the site's scope. Every failure is recorded and
 * the crawl carries on; nothing here throws for a bad site.
 */
export async function crawlCompanySite(
  companyUrl: string,
  deps: CrawlDeps,
  options: CrawlOptions = {},
): Promise<CrawlResult> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxPageBytes = options.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES;
  const startedAt = deps.clock.now();

  const pages: SourcePage[] = [];
  const failures: SourceFailure[] = [];
  const skipped: SkippedSource[] = [];
  const robots: RobotsSummary[] = [];
  const limitations: string[] = [];
  let status: CrawlStatus = 'ok';
  let budget: 'pages' | 'time' | null = null;

  const finish = (): CrawlResult => {
    const hiringPages = pages
      .filter(
        (p) => p.classification.role === 'hiring' || p.classification.role === 'hiring-process',
      )
      .sort(
        (a, b) =>
          b.classification.process_score - a.classification.process_score ||
          b.classification.hiring_score - a.classification.hiring_score ||
          (a.url < b.url ? -1 : 1),
      );

    const robotsSkips = skipped.filter((s) => s.reason === 'robots').length;
    if (robotsSkips > 0) {
      limitations.push(`${robotsSkips} page(s) were skipped because robots.txt disallows them.`);
    }
    const truncatedPages = pages.filter((p) => p.truncated).length;
    if (truncatedPages > 0) {
      limitations.push(
        `${truncatedPages} page(s) exceeded the size limit and were read only in part.`,
      );
    }
    if (pages.length > 0 && failures.length > 0) {
      limitations.push(`${failures.length} page(s) could not be retrieved (see failures).`);
    }
    if (budget === 'pages')
      limitations.push(
        `Stopped at the ${maxPages}-page limit; further candidate pages were not fetched.`,
      );
    if (budget === 'time')
      limitations.push(
        'Stopped because the research time budget ran out; further candidate pages were not fetched.',
      );
    if (pages.length > 0 && hiringPages.length === 0) {
      limitations.push(
        `No hiring or careers page was found on the ${pages.length} page(s) fetched from this site.`,
      );
    }

    return {
      company_url: companyUrl,
      status,
      pages,
      failures,
      skipped,
      robots,
      hiring: {
        found: hiringPages.length > 0,
        process_found: hiringPages.some((p) => p.classification.role === 'hiring-process'),
        page_urls: hiringPages.map((p) => p.url),
        method: 'content-heuristic',
      },
      limitations,
      stats: {
        requests: deps.fetcher.stats.requests,
        pages_fetched: pages.length,
        elapsed_ms: deps.clock.now() - startedAt,
        budget_exhausted: budget,
      },
    };
  };

  // 1. The URL must be acceptable before anything touches the network.
  let root: URL;
  try {
    root = validateUrl(companyUrl, deps.policy);
  } catch (err) {
    status = 'rejected';
    failures.push(toFailure(companyUrl, err));
    limitations.push(
      `The company URL was rejected: ${err instanceof Error ? err.message : 'invalid'}.`,
    );
    return finish();
  }
  const scope: Scope = createScope(root);
  const redirectGuard = (_from: URL, to: URL) => scope.contains(to);

  // 2. robots.txt, once per host (subdomains have their own).
  const robotsByHost = new Map<string, RobotsInfo>();
  const robotsFor = async (url: URL): Promise<RobotsInfo> => {
    const key = hostKey(url);
    const cached = robotsByHost.get(key);
    if (cached) return cached;
    const info = await loadRobots({
      origin: new URL(url.origin),
      fetch: (u, overrides) => deps.fetcher.fetch(u, { ...overrides, redirectGuard }),
      productToken: deps.productToken,
    });
    robotsByHost.set(key, info);
    robots.push({
      host: key,
      url: info.url,
      status: info.status,
      crawl_delay_ms: info.rules.crawlDelayMs,
    });
    if (info.rules.crawlDelayMs !== null) {
      deps.fetcher.setMinInterval(
        key,
        Math.max(deps.fetcher.minIntervalMs, info.rules.crawlDelayMs),
      );
    }
    if (info.limitation) limitations.push(info.limitation);
    return info;
  };

  const rootRobots = await robotsFor(root);
  if (!rootRobots.rules.allows(pathAndQuery(root))) {
    status = 'blocked-by-robots';
    skipped.push({ url: root.href, reason: 'robots' });
    if (rootRobots.status !== 'unreachable') {
      limitations.push(
        'robots.txt disallows crawling the company URL, so nothing was fetched from this site.',
      );
    }
    return finish();
  }

  // 3. Best-first crawl.
  const deduper = new ContentDeduper();
  const frontier: Candidate[] = [
    { url: root, key: urlKey(root), score: Number.MAX_SAFE_INTEGER, depth: 0 },
  ];
  const queued = new Set<string>([urlKey(root)]);
  const fetchedKeys = new Set<string>();
  let attempted = 0;
  let rootFailed = false;

  while (frontier.length > 0) {
    if (attempted >= maxPages) {
      budget = 'pages';
      break;
    }
    if (deps.deadline !== undefined && deps.clock.now() >= deps.deadline) {
      budget = 'time';
      break;
    }

    frontier.sort(
      (a, b) => priority(b) - priority(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    const candidate = frontier.shift()!;

    const hostRobots = await robotsFor(candidate.url);
    if (!hostRobots.rules.allows(pathAndQuery(candidate.url))) {
      skipped.push({ url: candidate.url.href, reason: 'robots' });
      continue;
    }

    attempted++;
    let result;
    try {
      result = await deps.fetcher.fetch(candidate.url.href, {
        redirectGuard,
        maxBytes: maxPageBytes,
        onOversize: 'truncate',
      });
    } catch (err) {
      if (err instanceof FetchError && err.message === RESEARCH_BUDGET_MESSAGE) {
        budget = 'time';
        break;
      }
      failures.push(toFailure(candidate.url.href, err));
      if (candidate.depth === 0) rootFailed = true;
      continue;
    }

    const finalUrl = new URL(result.url);
    const finalKey = urlKey(finalUrl);
    if (finalKey !== candidate.key && fetchedKeys.has(finalKey)) {
      skipped.push({
        url: candidate.url.href,
        reason: 'duplicate-url',
        duplicate_of: finalUrl.href,
      });
      continue;
    }
    fetchedKeys.add(finalKey);
    fetchedKeys.add(candidate.key);

    // A redirect can land on a path that robots.txt forbids; the fetched content is then discarded.
    if (finalKey !== candidate.key) {
      const finalRobots = await robotsFor(finalUrl);
      if (!finalRobots.rules.allows(pathAndQuery(finalUrl))) {
        skipped.push({ url: finalUrl.href, reason: 'robots' });
        continue;
      }
    }

    const extracted = extractPage(result.body, finalUrl);
    const duplicateOf = deduper.check(finalUrl.href, extracted.text);
    if (duplicateOf) {
      skipped.push({ url: finalUrl.href, reason: 'duplicate-content', duplicate_of: duplicateOf });
      continue;
    }

    const classification = classifyPage(finalUrl, extracted);
    pages.push({
      url: finalUrl.href,
      requested_url: result.requestedUrl,
      title: extracted.title,
      description: extracted.description,
      headings: extracted.headings,
      text: extracted.text,
      fetched_at: new Date(deps.clock.now()).toISOString(),
      status: result.status,
      content_type: result.contentType,
      depth: candidate.depth,
      role: candidate.depth === 0 ? 'home' : classification.role,
      classification: {
        role: classification.role,
        hiring_score: classification.hiringScore,
        process_score: classification.processScore,
        evidence: classification.evidence,
      },
      interview_mentions: classification.interviewMentions,
      links_found: extracted.links.length,
      truncated: result.truncated,
      content_hash: fingerprint(extracted.text).hash,
      provenance: 'observed',
    });

    if (extracted.nofollow || candidate.depth >= maxDepth) continue;
    for (const ranked of rankLinks(extracted.links)) {
      if (ranked.score <= 0 || !scope.contains(ranked.link.url)) continue;
      if (queued.has(ranked.key) || fetchedKeys.has(ranked.key)) continue;
      queued.add(ranked.key);
      frontier.push({
        url: ranked.link.url,
        key: ranked.key,
        score: ranked.score,
        depth: candidate.depth + 1,
      });
    }
  }

  // 4. Outcome.
  if (pages.length === 0) {
    const robotsBlocked = skipped.some((s) => s.reason === 'robots');
    if (rootFailed || failures.length > 0) {
      status = 'unreachable';
      const f = failures[0];
      if (f) {
        const detail = f.status ? `HTTP ${f.status}` : f.code;
        limitations.push(
          `The company URL could not be retrieved (${detail}, ${f.attempts} attempt${f.attempts === 1 ? '' : 's'}).`,
        );
      }
    } else if (robotsBlocked) {
      status = 'blocked-by-robots';
    }
  } else if (failures.length > 0) {
    status = 'partial';
  }
  return finish();
}
