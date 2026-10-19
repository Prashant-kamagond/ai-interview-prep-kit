import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchError, type FetchErrorCode } from './errors.js';
import { createNetworkPolicy } from './network-policy.js';
import { createSafeFetch, type Resolver } from './safe-fetch.js';
import {
  html,
  redirect,
  startServer,
  type RouteHandler,
  type TestServer,
} from './test-support/site-server.js';

const UA = 'TestBot/1.0 (+test)';
const servers: TestServer[] = [];

async function server(routes: Record<string, RouteHandler>) {
  const s = await startServer(routes);
  servers.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** Maps fixture.test to loopback, the way a real DNS answer would map a name to an address. */
function fixtureResolver(address = '127.0.0.1') {
  const calls: string[] = [];
  const resolver: Resolver = async (hostname) => {
    calls.push(hostname);
    return hostname === 'fixture.test' ? [address] : ['10.0.0.9'];
  };
  return { resolver, calls };
}

function fetcherFor(s: TestServer, options: Partial<Parameters<typeof createSafeFetch>[0]> = {}) {
  const { resolver, calls } = fixtureResolver();
  const fetch = createSafeFetch({
    userAgent: UA,
    policy: createNetworkPolicy({ loopbackHosts: [`fixture.test:${s.port}`] }),
    resolver,
    timeoutMs: 2000,
    ...options,
  });
  return { fetch, calls, url: (path = '/') => `http://fixture.test:${s.port}${path}` };
}

async function codeOf(promise: Promise<unknown>): Promise<FetchErrorCode | 'RESOLVED'> {
  try {
    await promise;
    return 'RESOLVED';
  } catch (err) {
    if (err instanceof FetchError) return err.code;
    throw err;
  }
}

describe('successful fetches', () => {
  it('fetches HTML, keeps the original Host header, and resolves the name exactly once', async () => {
    const s = await server({ '/': html('<h1>Hello</h1>') });
    const { fetch, calls, url } = fetcherFor(s);

    const res = await fetch(url('/'));

    expect(res.status).toBe(200);
    expect(res.body).toBe('<h1>Hello</h1>');
    expect(res.contentType).toBe('text/html');
    expect(res.url).toBe(url('/'));
    expect(res.redirects).toEqual([]);
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]?.headers.host).toBe(`fixture.test:${s.port}`);
    expect(calls).toEqual(['fixture.test']);
  });

  it('sends an honest User-Agent and never sends cookies or credentials', async () => {
    const s = await server({ '/': html('ok') });
    const { fetch, url } = fetcherFor(s);
    await fetch(url('/'));
    const headers = s.requests[0]!.headers;
    expect(headers['user-agent']).toBe(UA);
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers['proxy-authorization']).toBeUndefined();
  });

  it('decodes gzip bodies and honours the declared charset', async () => {
    const s = await server({
      '/gz': {
        headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
        body: gzipSync('<p>compressed</p>'),
      },
      '/latin': {
        headers: { 'content-type': 'text/html; charset=iso-8859-1' },
        body: Buffer.from('caf\xe9', 'latin1'),
      },
    });
    const { fetch, url } = fetcherFor(s);
    expect((await fetch(url('/gz'))).body).toBe('<p>compressed</p>');
    expect((await fetch(url('/latin'))).body).toBe('café');
  });
});

describe('DNS pinning (anti-rebinding)', () => {
  it('connects to the address it validated even if a later lookup would answer differently', async () => {
    const s = await server({ '/': html('pinned') });
    let calls = 0;
    // First answer: loopback (allow-listed for this fixture). Any second answer: a private address.
    const resolver: Resolver = async () => (++calls === 1 ? ['127.0.0.1'] : ['10.0.0.9']);
    const fetch = createSafeFetch({
      userAgent: UA,
      policy: createNetworkPolicy({ loopbackHosts: [`fixture.test:${s.port}`] }),
      resolver,
      timeoutMs: 2000,
    });

    const res = await fetch(`http://fixture.test:${s.port}/`);

    expect(res.body).toBe('pinned');
    expect(calls).toBe(1); // the HTTP client never resolved the name a second time
  });

  it('rejects a name that resolves to a private address, without connecting', async () => {
    const s = await server({ '/': html('secret') });
    const fetch = createSafeFetch({
      userAgent: UA,
      policy: createNetworkPolicy(),
      resolver: async () => ['127.0.0.1'],
      timeoutMs: 2000,
    });
    expect(await codeOf(fetch(`http://evil.example:80/`))).toBe('BLOCKED_ADDRESS');
    expect(s.requests).toHaveLength(0);
  });

  it('rejects when only one of several answers is private', async () => {
    const fetch = createSafeFetch({
      userAgent: UA,
      policy: createNetworkPolicy(),
      resolver: async () => ['93.184.216.34', '10.0.0.5'],
      timeoutMs: 2000,
    });
    expect(await codeOf(fetch('http://mixed.example/'))).toBe('BLOCKED_ADDRESS');
  });

  it('reports DNS failures', async () => {
    const fetch = createSafeFetch({
      userAgent: UA,
      policy: createNetworkPolicy(),
      resolver: async () => {
        throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
      },
      timeoutMs: 2000,
    });
    const err = await fetch('http://missing.example/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).code).toBe('DNS_FAILED');
    expect((err as FetchError).retryable).toBe(false);
  });

  it('treats a temporary DNS failure as retryable', async () => {
    const fetch = createSafeFetch({
      userAgent: UA,
      policy: createNetworkPolicy(),
      resolver: async () => {
        throw Object.assign(new Error('try again'), { code: 'EAI_AGAIN' });
      },
      timeoutMs: 2000,
    });
    const err = (await fetch('http://flaky.example/').catch((e: unknown) => e)) as FetchError;
    expect(err.code).toBe('DNS_FAILED');
    expect(err.retryable).toBe(true);
  });
});

describe('blocked destinations never reach the network', () => {
  it.each([
    'http://127.0.0.1:{port}/',
    'http://[::1]:{port}/',
    'http://2130706433:{port}/',
    'http://0x7f.1:{port}/',
    'http://[::ffff:7f00:1]:{port}/',
  ])('blocks %s in strict mode', async (template) => {
    const s = await server({ '/': html('should never be fetched') });
    const fetch = createSafeFetch({
      userAgent: UA,
      policy: createNetworkPolicy(),
      timeoutMs: 2000,
    });
    const code = await codeOf(fetch(template.replace('{port}', String(s.port))));
    expect(['BLOCKED_ADDRESS', 'INVALID_URL']).toContain(code);
    expect(s.requests).toHaveLength(0);
  });

  it.each(['http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'https://192.168.1.1/'])(
    'blocks %s',
    async (url) => {
      const fetch = createSafeFetch({
        userAgent: UA,
        policy: createNetworkPolicy(),
        timeoutMs: 500,
      });
      expect(await codeOf(fetch(url))).toBe('BLOCKED_ADDRESS');
    },
  );

  it.each([
    '',
    'not a url',
    'ftp://example.com/',
    'file:///etc/passwd',
    'http://user:pw@example.com/',
    'http://example.com:22/',
  ])('rejects malformed or unsupported URL %j', async (url) => {
    const fetch = createSafeFetch({ userAgent: UA, policy: createNetworkPolicy(), timeoutMs: 500 });
    expect(await codeOf(fetch(url))).toBe('INVALID_URL');
  });

  it('allows a literal loopback address only when that exact host:port is allow-listed', async () => {
    const s = await server({ '/': html('fixture') });
    const allowed = createSafeFetch({
      userAgent: UA,
      policy: createNetworkPolicy({ loopbackHosts: [s.key] }),
      timeoutMs: 2000,
    });
    expect((await allowed(s.origin)).body).toBe('fixture');

    const other = await server({ '/': html('other') });
    expect(await codeOf(allowed(other.origin))).toBe('INVALID_URL');
    expect(other.requests).toHaveLength(0);
  });
});

describe('redirects', () => {
  it('follows relative and absolute redirects and reports the chain and final URL', async () => {
    const s = await server({
      '/a': redirect('/b'),
      '/b': redirect('c/d'),
      '/c/d': html('arrived'),
    });
    const { fetch, url } = fetcherFor(s);
    const res = await fetch(url('/a'));
    expect(res.body).toBe('arrived');
    expect(res.url).toBe(url('/c/d'));
    expect(res.redirects).toEqual([url('/b'), url('/c/d')]);
  });

  it('revalidates every hop: a redirect to cloud metadata is blocked', async () => {
    const s = await server({ '/go': redirect('http://169.254.169.254/latest/meta-data/') });
    const { fetch, url } = fetcherFor(s);
    expect(await codeOf(fetch(url('/go')))).toBe('REDIRECT_BLOCKED');
  });

  it.each([
    'file:///etc/passwd',
    'ftp://example.com/x',
    'javascript:alert(1)',
    'http://user:pw@example.com/',
  ])('blocks a redirect to %s', async (target) => {
    const s = await server({ '/go': redirect(target) });
    const { fetch, url } = fetcherFor(s);
    expect(await codeOf(fetch(url('/go')))).toBe('REDIRECT_BLOCKED');
  });

  it('blocks a redirect to a hostname that resolves to a private address', async () => {
    const s = await server({ '/go': redirect(`http://rebinder.example/`) });
    const { fetch, url } = fetcherFor(s); // resolver answers 10.0.0.9 for anything but fixture.test
    expect(await codeOf(fetch(url('/go')))).toBe('REDIRECT_BLOCKED');
  });

  it('does not unlock other loopback servers: the allow-list is per host:port', async () => {
    const other = await server({ '/': html('internal service') });
    const s = await server({ '/go': redirect(other.origin) });
    const { fetch, url } = fetcherFor(s);
    expect(await codeOf(fetch(url('/go')))).toBe('REDIRECT_BLOCKED');
    expect(other.requests).toHaveLength(0);
  });

  it('stops redirect loops at the limit', async () => {
    const s = await server({ '/loop': redirect('/loop') });
    const { fetch, url } = fetcherFor(s, { maxRedirects: 3 });
    expect(await codeOf(fetch(url('/loop')))).toBe('TOO_MANY_REDIRECTS');
    expect(s.requests).toHaveLength(4); // initial request + 3 redirects
  });

  it('applies a caller-supplied redirect guard (e.g. same-site only)', async () => {
    const s = await server({ '/go': redirect('/elsewhere'), '/elsewhere': html('x') });
    const { fetch, url } = fetcherFor(s, { redirectGuard: () => false });
    expect(await codeOf(fetch(url('/go')))).toBe('REDIRECT_BLOCKED');
  });

  it('does not carry cookies or credentials to the redirect target', async () => {
    const s = await server({ '/a': redirect('/b'), '/b': html('ok') });
    const { fetch, url } = fetcherFor(s);
    await fetch(url('/a'));
    for (const r of s.requests) {
      expect(r.headers.cookie).toBeUndefined();
      expect(r.headers.authorization).toBeUndefined();
    }
  });
});

describe('response limits', () => {
  it('rejects a declared Content-Length over the limit before reading the body', async () => {
    const s = await server({
      '/big': { headers: { 'content-type': 'text/html' }, body: 'x'.repeat(5000) },
    });
    const { fetch, url } = fetcherFor(s, { maxBytes: 1000 });
    expect(await codeOf(fetch(url('/big')))).toBe('TOO_LARGE');
  });

  it('rejects a streamed body that exceeds the limit without a Content-Length', async () => {
    const s = await server({
      '/stream': (_req) => ({
        headers: { 'content-type': 'text/html', 'transfer-encoding': 'chunked' },
        body: 'y'.repeat(50_000),
      }),
    });
    const { fetch, url } = fetcherFor(s, { maxBytes: 10_000 });
    expect(await codeOf(fetch(url('/stream')))).toBe('TOO_LARGE');
  });

  it('bounds decompression: a small gzip that expands hugely is rejected', async () => {
    const bomb = gzipSync(Buffer.alloc(20_000_000, 0x61)); // ~20 KB on the wire, 20 MB decoded
    expect(bomb.length).toBeLessThan(100_000);
    const s = await server({
      '/bomb': { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body: bomb },
    });
    const { fetch, url } = fetcherFor(s, { maxBytes: 200_000 });
    expect(await codeOf(fetch(url('/bomb')))).toBe('TOO_LARGE');
  });

  it('rejects corrupt compressed data and unsupported encodings', async () => {
    const s = await server({
      '/corrupt': {
        headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
        body: Buffer.from('this is not gzip data at all'),
      },
      '/br': { headers: { 'content-type': 'text/html', 'content-encoding': 'br' }, body: 'x' },
    });
    const { fetch, url } = fetcherFor(s);
    expect(await codeOf(fetch(url('/corrupt')))).toBe('DECODE_ERROR');
    expect(await codeOf(fetch(url('/br')))).toBe('DECODE_ERROR');
  });
});

describe('content types', () => {
  it.each([
    'application/pdf',
    'image/png',
    'application/octet-stream',
    'application/zip',
    'video/mp4',
  ])('rejects %s', async (type) => {
    const s = await server({ '/f': { headers: { 'content-type': type }, body: 'binary' } });
    const { fetch, url } = fetcherFor(s);
    expect(await codeOf(fetch(url('/f')))).toBe('UNSUPPORTED_CONTENT_TYPE');
  });

  it('rejects a response with no Content-Type', async () => {
    const s = await server({ '/n': { headers: {}, body: 'mystery' } });
    const { fetch, url } = fetcherFor(s);
    expect(await codeOf(fetch(url('/n')))).toBe('UNSUPPORTED_CONTENT_TYPE');
  });

  it.each(['text/html', 'text/html; charset=utf-8', 'TEXT/HTML', 'application/xhtml+xml'])(
    'accepts %s by default',
    async (type) => {
      const s = await server({ '/f': { headers: { 'content-type': type }, body: '<p>ok</p>' } });
      const { fetch, url } = fetcherFor(s);
      expect(await codeOf(fetch(url('/f')))).toBe('RESOLVED');
    },
  );

  it('lets the caller choose the allow-list per request (e.g. JSON for an API)', async () => {
    const s = await server({
      '/j': { headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
    });
    const { fetch, url } = fetcherFor(s);
    expect(await codeOf(fetch(url('/j')))).toBe('UNSUPPORTED_CONTENT_TYPE');
    const res = await fetch(url('/j'), { allowedContentTypes: ['application/json'] });
    expect(JSON.parse(res.body)).toEqual({ a: 1 });
  });
});

describe('timeouts and failures', () => {
  it('times out when the server never answers', async () => {
    const s = await server({ '/hang': { hang: true } });
    const { fetch, url } = fetcherFor(s, { timeoutMs: 200 });
    const started = Date.now();
    const err = (await fetch(url('/hang')).catch((e: unknown) => e)) as FetchError;
    expect(err.code).toBe('TIMEOUT');
    expect(err.retryable).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('enforces the total deadline against a slow-drip body', async () => {
    const s = await server({ '/drip': { headers: { 'content-type': 'text/html' }, drip: true } });
    const { fetch, url } = fetcherFor(s, { timeoutMs: 300 });
    expect(await codeOf(fetch(url('/drip')))).toBe('TIMEOUT');
  });

  it('shares one deadline across redirect hops', async () => {
    const s = await server({
      '/a': { ...redirect('/b'), delayMs: 150 },
      '/b': { ...redirect('/c'), delayMs: 150 },
      '/c': html('late', { delayMs: 150 }),
    });
    const { fetch, url } = fetcherFor(s, { timeoutMs: 350 });
    expect(await codeOf(fetch(url('/a')))).toBe('TIMEOUT');
  });

  it('reports connection failures as retryable network errors', async () => {
    const s = await server({});
    const { fetch, url } = fetcherFor(s);
    await s.close();
    const err = (await fetch(url('/')).catch((e: unknown) => e)) as FetchError;
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.retryable).toBe(true);
  });

  it.each([
    [404, false],
    [403, false],
    [410, false],
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [504, true],
  ])('maps HTTP %i to HTTP_ERROR (retryable: %s)', async (status, retryable) => {
    const s = await server({
      '/e': { status, headers: { 'content-type': 'text/html' }, body: 'err' },
    });
    const { fetch, url } = fetcherFor(s);
    const err = (await fetch(url('/e')).catch((e: unknown) => e)) as FetchError;
    expect(err.code).toBe('HTTP_ERROR');
    expect(err.status).toBe(status);
    expect(err.retryable).toBe(retryable);
  });

  it('exposes Retry-After (seconds) on a 429', async () => {
    const s = await server({ '/e': { status: 429, headers: { 'retry-after': '3' }, body: '' } });
    const { fetch, url } = fetcherFor(s);
    const err = (await fetch(url('/e')).catch((e: unknown) => e)) as FetchError;
    expect(err.retryAfterMs).toBe(3000);
  });

  it('does not treat a redirect without a Location as success', async () => {
    const s = await server({ '/r': { status: 302, headers: {}, body: '' } });
    const { fetch, url } = fetcherFor(s);
    expect(await codeOf(fetch(url('/r')))).toBe('HTTP_ERROR');
  });
});

describe('onOversize: truncate (for pages that are merely large)', () => {
  it('returns the first maxBytes and marks the result truncated, for a declared length', async () => {
    const s = await server({ '/big': html('a'.repeat(5000)) });
    const { fetch, url } = fetcherFor(s, { maxBytes: 1000, onOversize: 'truncate' });
    const res = await fetch(url('/big'));
    expect(res.truncated).toBe(true);
    expect(res.body).toBe('a'.repeat(1000));
    expect(res.bytes).toBe(1000);
  });

  it('truncates a streamed body that has no Content-Length', async () => {
    const s = await server({
      '/stream': {
        headers: { 'content-type': 'text/html', 'transfer-encoding': 'chunked' },
        body: 'y'.repeat(50_000),
      },
    });
    const { fetch, url } = fetcherFor(s, { maxBytes: 10_000, onOversize: 'truncate' });
    const res = await fetch(url('/stream'));
    expect(res.truncated).toBe(true);
    expect(res.bytes).toBe(10_000);
  });

  it('stays bounded for a decompression bomb: it never decodes more than the limit', async () => {
    const bomb = gzipSync(Buffer.alloc(20_000_000, 0x61));
    const s = await server({
      '/bomb': { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body: bomb },
    });
    const { fetch, url } = fetcherFor(s, { maxBytes: 200_000, onOversize: 'truncate' });
    const res = await fetch(url('/bomb'));
    expect(res.truncated).toBe(true);
    expect(res.bytes).toBeLessThanOrEqual(200_000);
  });

  it('does not mark a body that fits as truncated', async () => {
    const s = await server({ '/ok': html('small') });
    const { fetch, url } = fetcherFor(s, { maxBytes: 1000, onOversize: 'truncate' });
    expect((await fetch(url('/ok'))).truncated).toBe(false);
  });

  it('can be chosen per request, and rejection stays the default', async () => {
    const s = await server({ '/big': html('a'.repeat(5000)) });
    const { fetch, url } = fetcherFor(s, { maxBytes: 1000 });
    expect(await codeOf(fetch(url('/big')))).toBe('TOO_LARGE');
    expect((await fetch(url('/big'), { onOversize: 'truncate' })).truncated).toBe(true);
  });
});

describe('TLS settings', () => {
  it('connects by hostname with certificate verification left on, via the pinned lookup', async () => {
    const captured: Record<string, unknown>[] = [];
    const transport = {
      http: vi.fn(),
      https: vi.fn((options: Record<string, unknown>) => {
        captured.push(options);
        throw new Error('stop before connecting');
      }),
    };
    const fetch = createSafeFetch({
      userAgent: UA,
      policy: createNetworkPolicy(),
      resolver: async () => ['93.184.216.34'],
      timeoutMs: 500,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      transport: transport as any,
    });

    await fetch('https://company.example/careers?x=1').catch(() => undefined);

    const options = captured[0]!;
    expect(options.hostname).toBe('company.example'); // name kept: SNI + certificate check use it
    expect(options.servername).toBe('company.example');
    expect(options.path).toBe('/careers?x=1');
    expect(options.rejectUnauthorized).not.toBe(false);
    expect(options.agent).toBe(false); // no shared pool that could reuse a socket across hosts
    expect(typeof options.lookup).toBe('function'); // validated, pinned resolution
    const headers = options.headers as Record<string, string>;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('cookie');
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('authorization');
  });
});
