import { promises as dnsPromises, type LookupAddress, type LookupOptions } from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';
import { createGunzip, createInflate } from 'node:zlib';
import { FetchError, RETRYABLE_STATUSES } from './errors.js';
import {
  bareHostname,
  checkResolvedAddresses,
  validateUrl,
  type NetworkPolicy,
} from './network-policy.js';

/** Resolves a hostname to every address it currently has. Injected so tests control DNS. */
export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolver: Resolver = async (hostname) => {
  const answers = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => a.address);
};

export interface Transport {
  http: typeof http.request;
  https: typeof https.request;
}

export interface SafeFetchOptions {
  userAgent: string;
  policy: NetworkPolicy;
  resolver?: Resolver;
  /** Test seam: replaces node's http/https request functions. */
  transport?: Transport;
  /** Total time for the whole fetch including every redirect hop. */
  timeoutMs?: number;
  /** Maximum time the socket may sit idle. */
  idleTimeoutMs?: number;
  maxRedirects?: number;
  /** Maximum bytes, both on the wire and after decompression. */
  maxBytes?: number;
  /**
   * What to do when a response is larger than `maxBytes`: `reject` fails with TOO_LARGE (the
   * default), `truncate` keeps the first `maxBytes` and marks the result `truncated`. Either way
   * memory use and decompression stay bounded.
   */
  onOversize?: 'reject' | 'truncate';
  allowedContentTypes?: readonly string[];
  accept?: string;
  /** Called for every redirect; return false to refuse it (for example, to stay on one site). */
  redirectGuard?: (from: URL, to: URL) => boolean;
}

export type PerRequestOptions = Pick<
  SafeFetchOptions,
  | 'timeoutMs'
  | 'maxBytes'
  | 'onOversize'
  | 'allowedContentTypes'
  | 'accept'
  | 'redirectGuard'
  | 'maxRedirects'
>;

export interface FetchResult {
  /** Final URL after redirects. */
  url: string;
  requestedUrl: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
  /** True when the body was cut at `maxBytes` (only possible with `onOversize: 'truncate'`). */
  truncated: boolean;
  redirects: string[];
}

export type SafeFetch = (url: string, overrides?: PerRequestOptions) => Promise<FetchResult>;

const DEFAULTS = {
  timeoutMs: 15_000,
  idleTimeoutMs: 8_000,
  maxRedirects: 5,
  maxBytes: 1_000_000,
  onOversize: 'reject' as 'reject' | 'truncate',
  allowedContentTypes: ['text/html', 'application/xhtml+xml'] as readonly string[],
  accept: 'text/html,application/xhtml+xml;q=0.9',
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type HopResult =
  | {
      kind: 'ok';
      status: number;
      contentType: string;
      body: string;
      bytes: number;
      truncated: boolean;
    }
  | { kind: 'redirect'; location: string };

interface ResolvedOptions {
  userAgent: string;
  policy: NetworkPolicy;
  resolver: Resolver;
  transport: Transport;
  idleTimeoutMs: number;
  maxBytes: number;
  onOversize: 'reject' | 'truncate';
  allowedContentTypes: readonly string[];
  accept: string;
}

function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  if (/^\d+$/.test(raw.trim())) return Math.min(Number(raw.trim()), 86_400) * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function mapError(err: unknown): FetchError {
  if (err instanceof FetchError) return err;
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? '';
  if (
    /^(ERR_TLS|ERR_SSL|ERR_OSSL|CERT_|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|HOSTNAME_MISMATCH)/.test(
      code,
    )
  ) {
    return new FetchError('TLS_ERROR', 'The secure connection could not be verified', {
      cause: err,
    });
  }
  if (code === 'ENOTFOUND')
    return new FetchError('DNS_FAILED', 'The host name did not resolve', { cause: err });
  return new FetchError('NETWORK_ERROR', `Network error (${code || 'unknown'})`, {
    retryable: true,
    cause: err,
  });
}

function decodeBody(buffer: Buffer, contentType: string): string {
  const charset = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

/**
 * Resolves the name ONCE, validates every answer, and hands that same validated address to the
 * socket. Node never performs a second, independent resolution, so a DNS answer that changes
 * between "check" and "connect" (rebinding) cannot redirect the connection. IP-literal hosts skip
 * DNS entirely and are validated before the request is made.
 */
function createPinnedLookup(
  url: URL,
  options: ResolvedOptions,
  onViolation: (err: FetchError) => void,
) {
  return (
    hostname: string,
    lookupOptions: LookupOptions,
    callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
  ): void => {
    options.resolver(hostname).then(
      (addresses) => {
        try {
          checkResolvedAddresses(url, addresses, options.policy);
        } catch (err) {
          const violation = mapError(err);
          onViolation(violation);
          callback(violation, '', 0);
          return;
        }
        let entries: LookupAddress[] = addresses.map((address) => ({
          address,
          family: isIP(address),
        }));
        if (lookupOptions.family === 4 || lookupOptions.family === 6) {
          entries = entries.filter((e) => e.family === lookupOptions.family);
        }
        const first = entries[0];
        if (!first) {
          callback(new FetchError('DNS_FAILED', 'The host has no usable address'), '', 0);
        } else if (lookupOptions.all) {
          callback(null, entries);
        } else {
          callback(null, first.address, first.family);
        }
      },
      (err: unknown) => {
        const temporary = (err as NodeJS.ErrnoException | undefined)?.code === 'EAI_AGAIN';
        callback(
          new FetchError('DNS_FAILED', 'The host name could not be resolved', {
            retryable: temporary,
            cause: err,
          }),
          '',
          0,
        );
      },
    );
  };
}

function hop(url: URL, options: ResolvedOptions, remainingMs: number): Promise<HopResult> {
  return new Promise<HopResult>((resolve, reject) => {
    let done = false;
    let violation: FetchError | null = null;
    let request: http.ClientRequest | undefined;

    const finish = (outcome: HopResult | Error): void => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      if (outcome instanceof Error) {
        request?.destroy();
        reject(outcome);
      } else {
        resolve(outcome);
      }
    };
    const deadline = setTimeout(
      () => finish(new FetchError('TIMEOUT', 'The request timed out', { retryable: true })),
      Math.max(1, remainingMs),
    );

    const isHttps = url.protocol === 'https:';
    const hostname = bareHostname(url);
    const literal = isIP(hostname) !== 0;
    const requestOptions: https.RequestOptions = {
      hostname,
      port: url.port ? Number(url.port) : isHttps ? 443 : 80,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      // Fixed header set. No cookies, no authorization, nothing taken from the caller or the page.
      headers: {
        'User-Agent': options.userAgent,
        Accept: options.accept,
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'en',
        Connection: 'close',
      },
      agent: false,
      timeout: options.idleTimeoutMs,
      lookup: createPinnedLookup(url, options, (v) => {
        violation = v;
      }) as unknown as https.RequestOptions['lookup'],
    };
    if (isHttps && !literal) requestOptions.servername = hostname; // SNI + certificate hostname check

    const abort = (err: FetchError, ...streams: Readable[]): void => {
      for (const s of streams) s.destroy();
      finish(err);
    };

    const onResponse = (res: http.IncomingMessage): void => {
      const status = res.statusCode ?? 0;

      if (REDIRECT_STATUSES.has(status)) {
        const location = res.headers.location;
        res.resume();
        if (location) finish({ kind: 'redirect', location });
        else finish(new FetchError('HTTP_ERROR', `HTTP ${status} without a Location`, { status }));
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        finish(
          new FetchError('HTTP_ERROR', `HTTP ${status}`, {
            status,
            retryable: RETRYABLE_STATUSES.has(status),
            ...(parseRetryAfter(res.headers['retry-after']) !== undefined
              ? { retryAfterMs: parseRetryAfter(res.headers['retry-after'])! }
              : {}),
          }),
        );
        return;
      }

      const contentType = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (!options.allowedContentTypes.includes(contentType)) {
        abort(
          new FetchError(
            'UNSUPPORTED_CONTENT_TYPE',
            `Unsupported content type: ${contentType || 'none'}`,
          ),
          res,
        );
        return;
      }
      const declared = Number(res.headers['content-length']);
      const truncating = options.onOversize === 'truncate';
      if (!truncating && Number.isFinite(declared) && declared > options.maxBytes) {
        abort(new FetchError('TOO_LARGE', 'The response is larger than the size limit'), res);
        return;
      }

      const encoding = String(res.headers['content-encoding'] ?? 'identity')
        .trim()
        .toLowerCase();
      const decoder =
        encoding === 'gzip' || encoding === 'x-gzip'
          ? createGunzip()
          : encoding === 'deflate'
            ? createInflate()
            : null;
      if (!decoder && encoding !== 'identity' && encoding !== '') {
        abort(new FetchError('DECODE_ERROR', 'Unsupported content encoding'), res);
        return;
      }

      const streams: Readable[] = decoder ? [res, decoder] : [res];
      const chunks: Buffer[] = [];
      let wire = 0;
      let total = 0;
      const complete = (truncated: boolean) => {
        const body = Buffer.concat(chunks);
        finish({
          kind: 'ok',
          status,
          contentType,
          body: decodeBody(body, String(res.headers['content-type'] ?? '')),
          bytes: body.length,
          truncated,
        });
      };
      // Oversize: either fail, or stop reading, keep what fits, and say so. Both paths destroy
      // the streams, so a huge or maliciously compressed body is never read to the end.
      const oversize = () => {
        if (!truncating) {
          abort(new FetchError('TOO_LARGE', 'The response exceeded the size limit'), ...streams);
          return;
        }
        for (const stream of streams) stream.destroy();
        complete(true);
      };

      // Compressed bytes are counted separately from decoded bytes. Without a decoder they are the
      // same stream, so the single counter below is enough.
      if (decoder) {
        res.on('data', (chunk: Buffer) => {
          wire += chunk.length;
          if (wire > options.maxBytes) oversize();
        });
      }
      const sink: Readable = decoder ? res.pipe(decoder) : res;
      sink.on('data', (chunk: Buffer) => {
        if (done) return;
        if (total + chunk.length > options.maxBytes) {
          if (truncating) chunks.push(chunk.subarray(0, options.maxBytes - total));
          oversize();
          return;
        }
        total += chunk.length;
        chunks.push(chunk);
      });
      sink.on('end', () => complete(false));
      decoder?.on('error', (err) =>
        abort(
          new FetchError('DECODE_ERROR', 'The response could not be decompressed', { cause: err }),
          ...streams,
        ),
      );
      res.on('error', (err) => finish(violation ?? mapError(err)));
      res.on('close', () => {
        if (!done && !res.complete)
          finish(
            new FetchError('NETWORK_ERROR', 'The connection closed early', { retryable: true }),
          );
      });
    };

    try {
      request = (isHttps ? options.transport.https : options.transport.http)(
        requestOptions,
        onResponse,
      );
    } catch (err) {
      finish(mapError(err));
      return;
    }
    request.on('timeout', () =>
      finish(new FetchError('TIMEOUT', 'The connection timed out', { retryable: true })),
    );
    request.on('error', (err) => finish(violation ?? mapError(err)));
    request.end();
  });
}

const POLICY_ERRORS = new Set(['INVALID_URL', 'BLOCKED_ADDRESS']);

export function createSafeFetch(defaults: SafeFetchOptions): SafeFetch {
  return async (rawUrl, overrides = {}) => {
    const merged = { ...DEFAULTS, ...stripUndefined(defaults), ...stripUndefined(overrides) };
    // A per-request timeout can only tighten the configured one, never loosen it.
    merged.timeoutMs = Math.min(
      defaults.timeoutMs ?? DEFAULTS.timeoutMs,
      overrides.timeoutMs ?? Number.POSITIVE_INFINITY,
    );
    const resolved: ResolvedOptions = {
      userAgent: defaults.userAgent,
      policy: defaults.policy,
      resolver: defaults.resolver ?? systemResolver,
      transport: defaults.transport ?? { http: http.request, https: https.request },
      idleTimeoutMs: Math.min(merged.idleTimeoutMs, merged.timeoutMs),
      maxBytes: merged.maxBytes,
      onOversize: merged.onOversize,
      allowedContentTypes: merged.allowedContentTypes,
      accept: merged.accept,
    };

    const startedAt = Date.now();
    const redirects: string[] = [];
    let current = validateUrl(rawUrl, defaults.policy);

    for (let hopIndex = 0; hopIndex <= merged.maxRedirects; hopIndex++) {
      const remaining = merged.timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0)
        throw new FetchError('TIMEOUT', 'The request timed out', { retryable: true });

      let result: HopResult;
      try {
        result = await hop(current, resolved, remaining);
      } catch (err) {
        // A redirect that leads somewhere forbidden is reported as such, whatever the reason.
        if (hopIndex > 0 && err instanceof FetchError && POLICY_ERRORS.has(err.code)) {
          throw new FetchError('REDIRECT_BLOCKED', `Redirect refused: ${err.message}`, {
            cause: err,
          });
        }
        throw err;
      }

      if (result.kind === 'ok') {
        return {
          url: current.href,
          requestedUrl: rawUrl,
          status: result.status,
          contentType: result.contentType,
          body: result.body,
          bytes: result.bytes,
          truncated: result.truncated,
          redirects,
        };
      }

      if (hopIndex === merged.maxRedirects) {
        throw new FetchError('TOO_MANY_REDIRECTS', 'Too many redirects');
      }

      let next: URL;
      try {
        next = validateUrl(new URL(result.location, current), defaults.policy);
      } catch (err) {
        throw new FetchError('REDIRECT_BLOCKED', `Redirect refused: ${mapError(err).message}`, {
          cause: err,
        });
      }
      if (current.protocol === 'https:' && next.protocol === 'http:') {
        throw new FetchError('REDIRECT_BLOCKED', 'Redirect refused: https to http downgrade');
      }
      if (merged.redirectGuard && !merged.redirectGuard(current, next)) {
        throw new FetchError('REDIRECT_BLOCKED', 'Redirect refused: outside the permitted scope');
      }
      redirects.push(next.href);
      current = next;
    }
    throw new FetchError('TOO_MANY_REDIRECTS', 'Too many redirects');
  };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
