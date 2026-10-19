/**
 * Public discussion of how a company interviews.
 *
 * Providers sit behind this small interface so another source can be added later if authorised
 * access is available. Only one provider exists today: Hacker News via the Algolia HN Search API.
 * Reddit's unauthenticated JSON endpoints and DuckDuckGo HTML are deliberately NOT used.
 */

export interface DiscussionQuery {
  company: string;
}

export interface DiscussionItem {
  /** A real, resolvable discussion URL. */
  url: string;
  source_id: string;
  kind: 'story' | 'comment';
  title: string | null;
  /** A short passage copied verbatim from the post (HTML removed), near the interview mention. */
  snippet: string;
  author: string | null;
  points: number | null;
  created_at: string | null;
  /** The interview-related phrases found in the post. */
  matched_terms: string[];
  provenance: 'observed';
}

export type DiscussionErrorCode =
  'RATE_LIMITED' | 'UPSTREAM_ERROR' | 'TIMEOUT' | 'MALFORMED_RESPONSE' | 'NETWORK_ERROR';

/**
 * ok           at least one relevant discussion was found
 * no_results   the service answered and nothing relevant exists (an honest empty result)
 * unavailable  the service could not be used; `error` says why
 */
export interface DiscussionResult {
  provider: string;
  status: 'ok' | 'no_results' | 'unavailable';
  items: DiscussionItem[];
  /** The exact search queries that were sent. */
  queries: string[];
  retrieved_at: string;
  error: { code: DiscussionErrorCode; message: string } | null;
  limitations: string[];
}

export interface DiscussionProvider {
  readonly id: string;
  search(query: DiscussionQuery): Promise<DiscussionResult>;
}
