import { FetchError } from './errors.js';
import type { FetchResult, PerRequestOptions } from './safe-fetch.js';

/**
 * robots.txt, following RFC 9309:
 *  - rules are grouped by User-agent; our own product token wins over `*`
 *  - the longest matching path pattern wins, and Allow wins a tie
 *  - `*` matches any run of characters, a trailing `$` anchors the end
 *  - 4xx (other than 429) means "no robots.txt": nothing is restricted
 *  - 5xx, 429, timeouts and network failures mean "unreachable": the crawler must assume
 *    everything is disallowed. That is the conservative choice, and the limitation is recorded.
 *
 * robots.txt is a politeness convention, not an access control: it is never a substitute for the
 * SSRF protections or for a site's terms.
 */

export interface RobotsRules {
  /** `pathAndQuery` is the URL's path plus query string, e.g. `/jobs?team=eng`. */
  allows(pathAndQuery: string): boolean;
  crawlDelayMs: number | null;
}

export const ALLOW_ALL: RobotsRules = { allows: () => true, crawlDelayMs: null };
export const DISALLOW_ALL: RobotsRules = { allows: () => false, crawlDelayMs: null };

interface Rule {
  allow: boolean;
  pattern: string;
  regex: RegExp;
}

interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelayMs: number | null;
}

function compilePattern(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

function agentToken(value: string): string {
  return value.toLowerCase().split('/')[0]!.trim();
}

export function parseRobots(content: string, productToken: string): RobotsRules {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  const body = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content; // strip a byte-order mark
  for (const rawLine of body.split(/\r\n|\n|\r/)) {
    const line = rawLine.split('#')[0]!.trim();
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelayMs: null };
        groups.push(current);
      }
      current.agents.push(agentToken(value));
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      if (!current) continue; // rules before any User-agent line are ignored
      lastWasAgent = false;
      if (value !== '') {
        current.rules.push({
          allow: key === 'allow',
          pattern: value,
          regex: compilePattern(value),
        });
      }
    } else if (key === 'crawl-delay') {
      if (!current) continue;
      lastWasAgent = false;
      const seconds = Number(value);
      if (
        value !== '' &&
        Number.isFinite(seconds) &&
        seconds >= 0 &&
        current.crawlDelayMs === null
      ) {
        current.crawlDelayMs = Math.round(seconds * 1000);
      }
    }
    // Sitemap and unknown directives do not affect grouping.
  }

  const token = agentToken(productToken);
  let matched = groups.filter((g) => g.agents.includes(token));
  if (matched.length === 0) matched = groups.filter((g) => g.agents.includes('*'));

  const rules = matched.flatMap((g) => g.rules);
  const crawlDelayMs = matched.find((g) => g.crawlDelayMs !== null)?.crawlDelayMs ?? null;

  return {
    crawlDelayMs,
    allows(pathAndQuery) {
      let best: Rule | null = null;
      for (const rule of rules) {
        if (!rule.regex.test(pathAndQuery)) continue;
        if (
          !best ||
          rule.pattern.length > best.pattern.length ||
          (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
        ) {
          best = rule;
        }
      }
      return best ? best.allow : true;
    },
  };
}

export type RobotsStatus = 'found' | 'not-found' | 'unreachable';

export interface RobotsInfo {
  url: string;
  status: RobotsStatus;
  rules: RobotsRules;
  /** Set when robots.txt could not be retrieved and crawling was therefore withheld. */
  limitation: string | null;
}

const ROBOTS_MAX_BYTES = 512 * 1024; // RFC 9309 asks crawlers to process at least 500 KiB
const ROBOTS_OPTIONS: PerRequestOptions = {
  maxBytes: ROBOTS_MAX_BYTES,
  // Some sites answer a missing robots.txt with an HTML 200; that parses to "no rules".
  allowedContentTypes: ['text/plain', 'text/html'],
  accept: 'text/plain,*/*;q=0.1',
};

export async function loadRobots(args: {
  origin: URL;
  fetch: (url: string, overrides?: PerRequestOptions) => Promise<FetchResult>;
  productToken: string;
}): Promise<RobotsInfo> {
  const url = new URL('/robots.txt', args.origin).href;
  try {
    const res = await args.fetch(url, ROBOTS_OPTIONS);
    return {
      url,
      status: 'found',
      rules: parseRobots(res.body, args.productToken),
      limitation: null,
    };
  } catch (err) {
    if (
      err instanceof FetchError &&
      err.code === 'HTTP_ERROR' &&
      err.status !== undefined &&
      err.status >= 400 &&
      err.status < 500 &&
      err.status !== 429
    ) {
      return { url, status: 'not-found', rules: ALLOW_ALL, limitation: null };
    }
    const why =
      err instanceof FetchError ? (err.status ? `HTTP ${err.status}` : err.code) : 'error';
    const attempts = err instanceof FetchError ? err.attempts : 1;
    return {
      url,
      status: 'unreachable',
      rules: DISALLOW_ALL,
      limitation:
        `robots.txt could not be retrieved (${why}, ${attempts} attempt${attempts === 1 ? '' : 's'}); ` +
        'no pages were fetched from this site, because crawling is only allowed when robots.txt can be read or is absent.',
    };
  }
}
