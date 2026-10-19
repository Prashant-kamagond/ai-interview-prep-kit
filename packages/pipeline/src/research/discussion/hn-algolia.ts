import type { Clock } from '../clock.js';
import { FetchError } from '../errors.js';
import type { FetchResult, PerRequestOptions } from '../safe-fetch.js';
import { assessHit, sanitizeCompanyName } from './relevance.js';
import type {
  DiscussionErrorCode,
  DiscussionItem,
  DiscussionProvider,
  DiscussionResult,
} from './types.js';

/**
 * Hacker News discussion search through the official Algolia HN Search API
 * (https://hn.algolia.com/api). It needs no key.
 *
 * Usage is deliberately small: at most two queries per company, one request per second at the
 * host (enforced by the polite fetcher that is passed in), bounded retries with Retry-After, and a
 * hard cap on results. The service publishes no explicit rate limit that we could verify, so the
 * budget is conservative rather than derived from one.
 *
 * Results are filtered locally: a post is kept only if it names the company as a whole word and
 * also uses interview vocabulary. If nothing passes, the result is an honest empty one.
 */

export const HN_ALGOLIA_BASE_URL = 'https://hn.algolia.com/api/v1';
const PROVIDER_ID = 'hn-algolia';
const ITEM_URL = 'https://news.ycombinator.com/item?id=';

export interface HnProviderOptions {
  /** The polite fetcher's fetch: SSRF-safe, spaced, retried. */
  fetch: (url: string, overrides?: PerRequestOptions) => Promise<FetchResult>;
  clock: Clock;
  baseUrl?: string;
  maxQueries?: number;
  maxItems?: number;
  hitsPerPage?: number;
  requestTimeoutMs?: number;
}

interface ProviderError {
  code: DiscussionErrorCode;
  message: string;
}

function mapError(err: unknown): ProviderError {
  if (err instanceof FetchError) {
    const tries = `${err.attempts} attempt${err.attempts === 1 ? '' : 's'}`;
    switch (err.code) {
      case 'HTTP_ERROR':
        return err.status === 429
          ? {
              code: 'RATE_LIMITED',
              message: `Hacker News search rate-limited the request (HTTP 429, ${tries}).`,
            }
          : {
              code: 'UPSTREAM_ERROR',
              message: `Hacker News search failed (HTTP ${err.status ?? 'error'}, ${tries}).`,
            };
      case 'TIMEOUT':
        return { code: 'TIMEOUT', message: `Hacker News search timed out (${tries}).` };
      case 'UNSUPPORTED_CONTENT_TYPE':
      case 'DECODE_ERROR':
      case 'TOO_LARGE':
        return {
          code: 'MALFORMED_RESPONSE',
          message: 'Hacker News search returned an unusable response.',
        };
      default:
        return {
          code: 'NETWORK_ERROR',
          message: `Hacker News search could not be reached (${tries}).`,
        };
    }
  }
  return { code: 'NETWORK_ERROR', message: 'Hacker News search could not be reached.' };
}

const MALFORMED: ProviderError = {
  code: 'MALFORMED_RESPONSE',
  message: 'Hacker News search returned an unusable response.',
};

/** Thrown by this module for a response that parsed as HTTP but not as the expected JSON. */
class MalformedResponseError extends Error {
  constructor() {
    super(MALFORMED.message);
    this.name = 'MalformedResponseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function createHnAlgoliaProvider(options: HnProviderOptions): DiscussionProvider {
  const baseUrl = options.baseUrl ?? HN_ALGOLIA_BASE_URL;
  const maxQueries = options.maxQueries ?? 2;
  const maxItems = options.maxItems ?? 8;
  const hitsPerPage = options.hitsPerPage ?? 20;
  const timeoutMs = options.requestTimeoutMs ?? 8000;

  async function runQuery(query: string): Promise<unknown[]> {
    const url = new URL(`${baseUrl}/search`);
    url.searchParams.set('query', query);
    url.searchParams.set('tags', '(story,comment)');
    url.searchParams.set('hitsPerPage', String(hitsPerPage));

    const response = await options.fetch(url.href, {
      allowedContentTypes: ['application/json'],
      accept: 'application/json',
      maxBytes: 1_000_000,
      timeoutMs,
    });
    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      throw new MalformedResponseError();
    }
    if (!isRecord(body) || !Array.isArray(body.hits)) throw new MalformedResponseError();
    return body.hits;
  }

  return {
    id: PROVIDER_ID,

    async search({ company }): Promise<DiscussionResult> {
      const retrievedAt = new Date(options.clock.now()).toISOString();
      const name = sanitizeCompanyName(company);
      const limitations: string[] = [];
      const base = { provider: PROVIDER_ID, retrieved_at: retrievedAt };

      if (name.length < 2) {
        return {
          ...base,
          status: 'no_results',
          items: [],
          queries: [],
          error: null,
          limitations: ['No usable company name was available, so Hacker News was not searched.'],
        };
      }

      const queries = [`"${name}" interview process`, `"${name}" interview`].slice(0, maxQueries);
      const sent: string[] = [];
      const items = new Map<string, DiscussionItem>();
      const errors: ProviderError[] = [];
      let succeeded = 0;

      for (const query of queries) {
        if (items.size >= maxItems) break;
        sent.push(query);
        let hits: unknown[];
        try {
          hits = await runQuery(query);
        } catch (err) {
          const mapped = err instanceof MalformedResponseError ? MALFORMED : mapError(err);
          errors.push(mapped);
          if (mapped.code === 'RATE_LIMITED') break; // do not keep asking a service that said slow down
          continue;
        }
        succeeded++;

        for (const raw of hits) {
          if (items.size >= maxItems) break;
          if (!isRecord(raw) || typeof raw.objectID !== 'string' || raw.objectID === '') continue;
          if (items.has(raw.objectID)) continue;
          const assessment = assessHit(raw, name);
          if (!assessment.relevant) continue;

          const tags = Array.isArray(raw._tags) ? raw._tags : [];
          const isComment = tags.includes('comment');
          const title = typeof raw.title === 'string' && raw.title !== '' ? raw.title : null;
          const storyTitle =
            typeof raw.story_title === 'string' && raw.story_title !== '' ? raw.story_title : null;
          items.set(raw.objectID, {
            url: `${ITEM_URL}${encodeURIComponent(raw.objectID)}`,
            source_id: raw.objectID,
            kind: isComment ? 'comment' : 'story',
            title: isComment ? storyTitle : title,
            snippet: assessment.snippet,
            author: typeof raw.author === 'string' ? raw.author : null,
            points: typeof raw.points === 'number' ? raw.points : null,
            created_at: isoOrNull(raw.created_at),
            matched_terms: assessment.matchedTerms,
            provenance: 'observed',
          });
        }
      }

      const found = [...items.values()];
      if (succeeded === 0 && errors.length > 0) {
        return {
          ...base,
          status: 'unavailable',
          items: [],
          queries: sent,
          error: errors[0]!,
          limitations: [`Hacker News discussion could not be searched: ${errors[0]!.message}`],
        };
      }
      if (errors.length > 0) {
        limitations.push(
          `A follow-up query failed (${errors[0]!.code}); results may be incomplete.`,
        );
      }
      if (found.length === 0) {
        limitations.push(
          "No relevant Hacker News discussion of this company's interview process was found.",
        );
      }

      return {
        ...base,
        status: found.length > 0 ? 'ok' : 'no_results',
        items: found,
        queries: sent,
        error: null,
        limitations,
      };
    },
  };
}
