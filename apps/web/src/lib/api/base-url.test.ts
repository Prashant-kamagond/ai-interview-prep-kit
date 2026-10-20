import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkProductionEnv } from '../../../scripts/check-production-env';
import { ApiError, createApiClient, resolveBaseUrl } from './client';
import {
  ApiConfigError,
  LOCAL_API_URL,
  isLoopbackHost,
  isSameOriginPath,
  problemsWithDeployedApiUrl,
  resolveApiBaseUrl,
} from './base-url';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('isLoopbackHost', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    'app.localhost',
    '127.0.0.1',
    '127.1.2.3',
    '[::1]',
    '::1',
    '0.0.0.0',
  ])('%s is local', (host) => expect(isLoopbackHost(host)).toBe(true));
  it.each([
    'example.com',
    'api.example.com',
    'localhost.example.com',
    '10.0.0.5',
    '192.168.1.1',
    '1270.0.0.1',
    'my-localhost.dev',
  ])('%s is not loopback', (host) => expect(isLoopbackHost(host)).toBe(false));
});

describe('on a developer machine (the page is served from a loopback host)', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])(
    'an unset address means the local API (%s)',
    (pageHostname) => {
      expect(resolveApiBaseUrl({ explicit: undefined, pageHostname })).toBe(LOCAL_API_URL);
      expect(resolveApiBaseUrl({ explicit: '   ', pageHostname })).toBe(LOCAL_API_URL);
    },
  );

  it('a configured address is used as given, without a trailing slash, even if it is http or local', () => {
    expect(
      resolveApiBaseUrl({ explicit: 'http://localhost:4100///', pageHostname: 'localhost' }),
    ).toBe('http://localhost:4100');
    expect(
      resolveApiBaseUrl({ explicit: 'http://192.168.1.5:4000', pageHostname: 'localhost' }),
    ).toBe('http://192.168.1.5:4000');
  });

  it('with no page at all (server rendering, Node tests) an unset address is the local default and nothing throws', () => {
    expect(resolveApiBaseUrl({ explicit: undefined, pageHostname: null })).toBe(LOCAL_API_URL);
  });
});

describe('on a deployed host the app never silently calls localhost', () => {
  const page = 'app.example.com';

  it('refuses an unset address with a message naming the variable', () => {
    for (const explicit of [undefined, '', '  ']) {
      expect(() => resolveApiBaseUrl({ explicit, pageHostname: page })).toThrow(ApiConfigError);
      expect(() => resolveApiBaseUrl({ explicit, pageHostname: page })).toThrow(
        /NEXT_PUBLIC_API_URL is not set/,
      );
    }
  });

  it.each([
    ['http://localhost:4000', /loopback/],
    ['https://localhost:4000', /loopback/],
    ['https://127.0.0.1', /loopback/],
    ['http://api.example.com', /https/],
    ['ftp://api.example.com', /http\(s\)/],
    ['not a url', /valid URL/],
    ['https://user:secret@api.example.com', /credentials/],
  ])('refuses %s', (explicit, reason) => {
    expect(() => resolveApiBaseUrl({ explicit, pageHostname: page })).toThrow(reason);
  });

  it('never repeats a value from the configuration in its message', () => {
    try {
      resolveApiBaseUrl({ explicit: 'https://user:topsecret@api.example.com', pageHostname: page });
    } catch (error) {
      expect((error as Error).message).not.toContain('topsecret');
    }
  });

  it('accepts a public https address, with or without a path slash', () => {
    expect(resolveApiBaseUrl({ explicit: 'https://api.example.com', pageHostname: page })).toBe(
      'https://api.example.com',
    );
    expect(resolveApiBaseUrl({ explicit: 'https://api.example.com/', pageHostname: page })).toBe(
      'https://api.example.com',
    );
  });
});

describe('problemsWithDeployedApiUrl (what a deployment build checks)', () => {
  it('has no problems for a public https address', () => {
    expect(problemsWithDeployedApiUrl('https://api.example.com')).toEqual([]);
  });
  it('lists every problem', () => {
    expect(problemsWithDeployedApiUrl(undefined)).toEqual(['NEXT_PUBLIC_API_URL is not set']);
    expect(problemsWithDeployedApiUrl('http://localhost:4000')).toEqual([
      'NEXT_PUBLIC_API_URL must use https',
      'NEXT_PUBLIC_API_URL points at a loopback host (localhost)',
    ]);
  });
});

describe('the client', () => {
  it('on a deployed host with no address configured, fails every call with a clear message and never touches the network', async () => {
    vi.stubGlobal('window', { location: { hostname: 'app.example.com' } });
    vi.stubEnv('NEXT_PUBLIC_API_URL', '');
    const fetchSpy = vi.fn();
    const client = createApiClient({ fetch: fetchSpy as unknown as typeof fetch });
    const error = await client.get('/kits').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, code: 'CONFIG_ERROR' });
    expect((error as ApiError).message).toMatch(/not set up correctly/);
    expect((error as ApiError).message).not.toMatch(/localhost|NEXT_PUBLIC/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('on a deployed host with a localhost address configured, refuses too', async () => {
    vi.stubGlobal('window', { location: { hostname: 'app.example.com' } });
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:4000');
    const fetchSpy = vi.fn();
    await expect(
      createApiClient({ fetch: fetchSpy as unknown as typeof fetch }).get('/kits'),
    ).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('on a deployed host with a good address, calls exactly that address', async () => {
    vi.stubGlobal('window', { location: { hostname: 'app.example.com' } });
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/');
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ kits: [] }), { status: 200 }));
    await createApiClient({ fetch: fetchSpy as unknown as typeof fetch }).get('/kits');
    expect(fetchSpy).toHaveBeenCalledWith('https://api.example.com/kits', expect.anything());
  });

  it('locally, with nothing configured, still calls the local API (development is unchanged)', async () => {
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    vi.stubEnv('NEXT_PUBLIC_API_URL', '');
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ kits: [] }), { status: 200 }));
    await createApiClient({ fetch: fetchSpy as unknown as typeof fetch }).get('/kits');
    expect(fetchSpy).toHaveBeenCalledWith(`${LOCAL_API_URL}/kits`, expect.anything());
    expect(resolveBaseUrl()).toBe(LOCAL_API_URL);
  });

  it('an explicit address in the options always wins over the environment', async () => {
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com');
    expect(resolveBaseUrl('http://api.test/')).toBe('http://api.test');
  });
});

describe('a same-origin path (page and API on one domain, as on Vercel)', () => {
  it.each(['/api', '/api/', '/api/v1', '/a-b/c_d.e'])('%s is a valid same-origin path', (v) =>
    expect(isSameOriginPath(v)).toBe(true),
  );
  it.each([
    '/',
    '//',
    '//evil.example.com',
    '/api//x',
    '/api/../admin',
    '/./api',
    '/api?x=1',
    '/api#top',
    '/api x',
    '/api%2e%2e',
    'api',
    'https://api.example.com',
  ])('%s is not', (v) => expect(isSameOriginPath(v)).toBe(false));

  it('is accepted on a deployed host and on localhost, without a trailing slash', () => {
    for (const pageHostname of ['app.example.com', 'localhost']) {
      expect(resolveApiBaseUrl({ explicit: '/api', pageHostname })).toBe('/api');
      expect(resolveApiBaseUrl({ explicit: '/api///', pageHostname })).toBe('/api');
    }
  });

  it('is refused with no page (it cannot be resolved outside a browser) and when malformed', () => {
    expect(() => resolveApiBaseUrl({ explicit: '/api', pageHostname: null })).toThrow(
      /only works in a browser/,
    );
    for (const explicit of ['//evil.example.com', '/api/../x', '/api?x=1']) {
      expect(() => resolveApiBaseUrl({ explicit, pageHostname: 'app.example.com' })).toThrow(
        /same-origin path/,
      );
    }
  });

  it('is fit for a deployment build, malformed paths are not', () => {
    expect(problemsWithDeployedApiUrl('/api')).toEqual([]);
    expect(problemsWithDeployedApiUrl('//evil.example.com')).toEqual([
      'NEXT_PUBLIC_API_URL is not a valid same-origin path',
    ]);
  });

  it("the client calls the page's own origin: /api + /kits is /api/kits", async () => {
    vi.stubGlobal('window', { location: { hostname: 'app.example.com' } });
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api');
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ kits: [] }), { status: 200 }));
    await createApiClient({ fetch: fetchSpy as unknown as typeof fetch }).get('/kits');
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/kits',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('a malformed path on a deployed host fails every call without touching the network', async () => {
    vi.stubGlobal('window', { location: { hostname: 'app.example.com' } });
    vi.stubEnv('NEXT_PUBLIC_API_URL', '//evil.example.com');
    const fetchSpy = vi.fn();
    await expect(
      createApiClient({ fetch: fetchSpy as unknown as typeof fetch }).get('/kits'),
    ).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the production build check', () => {
  it('passes only for a public https address', () => {
    expect(checkProductionEnv({ NEXT_PUBLIC_API_URL: 'https://api.example.com' })).toEqual([]);
    expect(checkProductionEnv({})).not.toEqual([]);
    expect(checkProductionEnv({ NEXT_PUBLIC_API_URL: 'http://localhost:4000' })).not.toEqual([]);
    expect(checkProductionEnv({ NEXT_PUBLIC_API_URL: 'http://api.example.com' })).not.toEqual([]);
  });

  const script = join(process.cwd(), 'apps/web/scripts/check-production-env.ts');
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ['--import', 'tsx', script], {
      env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv,
      encoding: 'utf8',
      cwd: process.cwd(),
    });

  it('as a command, fails the build (exit 1) without a public address, and says what to do', () => {
    const result = run({});
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/NEXT_PUBLIC_API_URL is not set/);
    expect(result.stderr).toMatch(/docs\/deployment\.md/);
  });

  it('as a command, fails for localhost and for http, without printing the value it was given', () => {
    const local = run({ NEXT_PUBLIC_API_URL: 'http://localhost:4000' });
    expect(local.status).toBe(1);
    const insecure = run({ NEXT_PUBLIC_API_URL: 'http://user:topsecret@api.example.com' });
    expect(insecure.status).toBe(1);
    expect(insecure.stderr + insecure.stdout).not.toContain('topsecret');
  });

  it('as a command, passes (exit 0) for a same-origin path and fails for a malformed one', () => {
    expect(run({ NEXT_PUBLIC_API_URL: '/api' }).status).toBe(0);
    const bad = run({ NEXT_PUBLIC_API_URL: '//evil.example.com' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/same-origin path/);
  });

  it('as a command, passes (exit 0) for a public https address', () => {
    const ok = run({ NEXT_PUBLIC_API_URL: 'https://api.example.com' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/ok/);
  });
});
