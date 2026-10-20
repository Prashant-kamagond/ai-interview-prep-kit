/**
 * The browser's only way to talk to the API. Every call sends the session cookie (`credentials:
 * 'include'`; the API allows exactly one web origin) and every failure becomes an ApiError with a
 * stable code and a message that is safe to show: server errors keep their curated text, and
 * anything unexpected (an HTML error page, a dropped connection) gets a fixed, generic sentence.
 */

import { ApiConfigError, resolveApiBaseUrl } from './base-url';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface ApiClientOptions {
  /** Defaults to NEXT_PUBLIC_API_URL, then http://localhost:4000. No trailing slash needed. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** How long to wait for one response. Default 30 s. */
  timeoutMs?: number;
  /** Called when the server says the session is missing or expired (not for a wrong password). */
  onUnauthorized?: (error: ApiError) => void;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface ApiClient {
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  delete<T>(path: string, options?: RequestOptions): Promise<T>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Codes that mean "there is no valid session", as opposed to a failed sign-in attempt. */
const SESSION_CODES: ReadonlySet<string> = new Set(['UNAUTHENTICATED', 'SESSION_EXPIRED']);

const GENERIC_BY_STATUS = (status: number): string => {
  if (status === 401) return 'Please sign in again.';
  if (status === 403) return 'You are not allowed to do that.';
  if (status === 404) return 'That could not be found.';
  if (status === 409) return 'That was changed by someone else. Reload and try again.';
  if (status === 413) return 'That is too large to send.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status >= 500) return 'The server had a problem. Please try again in a moment.';
  return 'The request could not be completed.';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The API's one error shape: { error: { code, message, details?, request_id? } }. */
function errorFromBody(status: number, body: unknown): ApiError {
  const e = isRecord(body) && isRecord(body.error) ? body.error : null;
  if (e && typeof e.code === 'string' && typeof e.message === 'string') {
    return new ApiError(
      status,
      e.code,
      e.message,
      e.details,
      typeof e.request_id === 'string' ? e.request_id : undefined,
    );
  }
  return new ApiError(status, `HTTP_${status}`, GENERIC_BY_STATUS(status));
}

/**
 * The API address. `process.env.NEXT_PUBLIC_API_URL` must stay a literal read: Next replaces it with the value
 * from build time. See base-url.ts for why an unset address is only tolerated on the developer's own machine.
 */
export function resolveBaseUrl(explicit?: string): string {
  return resolveApiBaseUrl({
    explicit: explicit ?? process.env.NEXT_PUBLIC_API_URL,
    pageHostname: typeof window === 'undefined' ? null : window.location.hostname,
  });
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    callOptions: RequestOptions = {},
  ): Promise<T> {
    // A call that was cancelled before it started never reaches the network.
    if (callOptions.signal?.aborted) throw new ApiError(0, 'ABORTED', 'The request was cancelled.');

    // Resolved per request, not when the module loads, so a misconfigured deployment answers with a clear
    // message when someone uses it instead of failing the build of every page that imports the client.
    let baseUrl: string;
    try {
      baseUrl = resolveBaseUrl(options.baseUrl);
    } catch (error) {
      if (!(error instanceof ApiConfigError)) throw error;
      throw new ApiError(
        0,
        'CONFIG_ERROR',
        'This site is not set up correctly: the address of its server is missing or invalid. Please tell whoever runs it.',
      );
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    // The caller may cancel too (for example when a component unmounts).
    const onCallerAbort = () => controller.abort();
    callOptions.signal?.addEventListener('abort', onCallerAbort, { once: true });

    let response: Response;
    let text: string;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        credentials: 'include',
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      text = await response.text();
    } catch {
      if (timedOut) {
        throw new ApiError(0, 'TIMEOUT', 'The server took too long to respond. Please try again.');
      }
      if (callOptions.signal?.aborted)
        throw new ApiError(0, 'ABORTED', 'The request was cancelled.');
      throw new ApiError(
        0,
        'NETWORK_ERROR',
        'Could not reach the server. Check your connection and try again.',
      );
    } finally {
      clearTimeout(timer);
      callOptions.signal?.removeEventListener('abort', onCallerAbort);
    }

    let parsed: unknown;
    let parsedOk = false;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
        parsedOk = true;
      } catch {
        parsedOk = false;
      }
    }

    if (!response.ok) {
      const error = errorFromBody(response.status, parsedOk ? parsed : undefined);
      if (response.status === 401 && SESSION_CODES.has(error.code)) options.onUnauthorized?.(error);
      throw error;
    }
    if (response.status === 204 || text === '') return undefined as T;
    if (!parsedOk) {
      throw new ApiError(
        response.status,
        'BAD_RESPONSE',
        'The server sent a response this page could not read.',
      );
    }
    return parsed as T;
  }

  return {
    get: (path, o) => request('GET', path, undefined, o),
    post: (path, body, o) => request('POST', path, body, o),
    put: (path, body, o) => request('PUT', path, body, o),
    delete: (path, o) => request('DELETE', path, undefined, o),
  };
}
