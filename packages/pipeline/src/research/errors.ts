export type FetchErrorCode =
  | 'INVALID_URL'
  | 'BLOCKED_ADDRESS'
  | 'BLOCKED_BY_ROBOTS'
  | 'DNS_FAILED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'TLS_ERROR'
  | 'TOO_MANY_REDIRECTS'
  | 'REDIRECT_BLOCKED'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'DECODE_ERROR'
  | 'HTTP_ERROR';

export interface FetchErrorOptions {
  retryable?: boolean;
  status?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

/**
 * Every way a retrieval can fail. Messages are written to be safe to show to a user: they never
 * contain resolved IP addresses, response bodies or credentials.
 */
export class FetchError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  /** How many attempts were made before giving up (set by the retry wrapper). */
  attempts = 1;

  constructor(
    readonly code: FetchErrorCode,
    message: string,
    options: FetchErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'FetchError';
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** HTTP statuses worth retrying: rate limiting and transient server-side failures. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
