import { describe, expect, it, vi } from 'vitest';
import { createAuthApi } from './auth';
import { ApiError, createApiClient, resolveBaseUrl } from './client';

type FetchArgs = Parameters<typeof fetch>;

/** A fetch that records its calls and answers from a queue. */
function fakeFetch(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = async (...args: FetchArgs): Promise<Response> => {
    calls.push({ url: String(args[0]), init: args[1] ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('no more responses queued');
    if (next instanceof Error) throw next;
    return next;
  };
  return { impl: impl as typeof fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string, message: string, extra: object = {}) =>
  json(status, { error: { code, message, request_id: 'req-1', ...extra } });

async function errorOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error('expected a failure');
}

describe('requests', () => {
  it('sends the session cookie, asks for JSON and sends no body on a GET', async () => {
    const { impl, calls } = fakeFetch(json(200, { ok: true }));
    const client = createApiClient({ baseUrl: 'http://api.test/', fetch: impl });
    expect(await client.get('/kits')).toEqual({ ok: true });
    expect(calls[0]!.url).toBe('http://api.test/kits');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.credentials).toBe('include');
    expect(calls[0]!.init.body).toBeUndefined();
    expect(calls[0]!.init.headers).toEqual({ accept: 'application/json' });
  });

  it('sends a JSON body with a content type on POST and PUT', async () => {
    const { impl, calls } = fakeFetch(json(201, { id: 1 }), json(200, { id: 1 }));
    const client = createApiClient({ baseUrl: 'http://api.test', fetch: impl });
    await client.post('/kits', { kit: 1 });
    await client.put('/kits/1', { version: 2 });
    expect(calls[0]!.init.body).toBe(JSON.stringify({ kit: 1 }));
    expect(calls[0]!.init.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(calls[1]!.init.method).toBe('PUT');
  });

  it('returns undefined for a 204 and for an empty successful body', async () => {
    const { impl } = fakeFetch(
      new Response(null, { status: 204 }),
      new Response('', { status: 200 }),
    );
    const client = createApiClient({ baseUrl: 'http://api.test', fetch: impl });
    expect(await client.delete('/kits/1')).toBeUndefined();
    expect(await client.get('/x')).toBeUndefined();
  });

  it('strips trailing slashes from the base URL and has a local default', () => {
    expect(resolveBaseUrl('http://api.test///')).toBe('http://api.test');
    expect(resolveBaseUrl()).toMatch(/^http/);
  });
});

describe('failures', () => {
  it('turns the API error shape into an ApiError with code, message, details and request id', async () => {
    const { impl } = fakeFetch(
      apiError(400, 'VALIDATION_ERROR', 'Invalid request', {
        details: [{ path: 'email', message: 'bad' }],
      }),
    );
    const err = await errorOf(
      createApiClient({ baseUrl: 'http://api.test', fetch: impl }).post('/auth/login', {}),
    );
    expect(err).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Invalid request',
      requestId: 'req-1',
      details: [{ path: 'email', message: 'bad' }],
    });
  });

  it('never shows a non-JSON error page; it uses a fixed sentence by status', async () => {
    const { impl } = fakeFetch(
      new Response('<html>502 Bad Gateway at internal-host:4000 <script>x</script></html>', {
        status: 502,
      }),
    );
    const err = await errorOf(
      createApiClient({ baseUrl: 'http://api.test', fetch: impl }).get('/kits'),
    );
    expect(err.code).toBe('HTTP_502');
    expect(err.message).toBe('The server had a problem. Please try again in a moment.');
    expect(err.message).not.toMatch(/internal-host|html|script/i);
  });

  it('ignores a JSON error body that is not in the API shape', async () => {
    const { impl } = fakeFetch(json(500, { stack: 'at /srv/app.ts:12', error: 'plain string' }));
    const err = await errorOf(
      createApiClient({ baseUrl: 'http://api.test', fetch: impl }).get('/kits'),
    );
    expect(err.code).toBe('HTTP_500');
    expect(err.message).not.toContain('/srv/app.ts');
  });

  it('reports a dropped connection as NETWORK_ERROR without the underlying text', async () => {
    const { impl } = fakeFetch(new TypeError('fetch failed: connect ECONNREFUSED 10.1.2.3:4000'));
    const err = await errorOf(
      createApiClient({ baseUrl: 'http://api.test', fetch: impl }).get('/kits'),
    );
    expect(err).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    expect(err.message).not.toMatch(/ECONNREFUSED|10\.1\.2\.3/);
  });

  it('reports a successful status with an unreadable body as BAD_RESPONSE', async () => {
    const { impl } = fakeFetch(new Response('not json at all', { status: 200 }));
    const err = await errorOf(
      createApiClient({ baseUrl: 'http://api.test', fetch: impl }).get('/kits'),
    );
    expect(err.code).toBe('BAD_RESPONSE');
  });

  it('times out when the server does not answer', async () => {
    const hang = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch;
    const err = await errorOf(
      createApiClient({ baseUrl: 'http://api.test', fetch: hang, timeoutMs: 20 }).get('/kits'),
    );
    expect(err).toMatchObject({ status: 0, code: 'TIMEOUT' });
  });

  it('lets the caller cancel a request, and reports it as ABORTED', async () => {
    const hang = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch;
    const controller = new AbortController();
    const client = createApiClient({ baseUrl: 'http://api.test', fetch: hang, timeoutMs: 5000 });
    const pending = errorOf(client.get('/kits', { signal: controller.signal }));
    controller.abort();
    expect((await pending).code).toBe('ABORTED');
    // already aborted before the call: nothing is sent at all
    const never = vi.fn();
    const aborted = createApiClient({
      baseUrl: 'http://api.test',
      fetch: never as unknown as typeof fetch,
    });
    expect((await errorOf(aborted.get('/kits', { signal: controller.signal }))).code).toBe(
      'ABORTED',
    );
    expect(never).not.toHaveBeenCalled();
  });

  it('always throws ApiError, never a raw error', async () => {
    const { impl } = fakeFetch(new Error('anything at all'));
    const err = await errorOf(
      createApiClient({ baseUrl: 'http://api.test', fetch: impl }).get('/kits'),
    );
    expect(err.name).toBe('ApiError');
  });
});

describe('a lost session', () => {
  it.each(['UNAUTHENTICATED', 'SESSION_EXPIRED'])(
    'calls onUnauthorized once for 401 %s',
    async (code) => {
      const onUnauthorized = vi.fn();
      const { impl } = fakeFetch(apiError(401, code, 'Authentication required'));
      const err = await errorOf(
        createApiClient({ baseUrl: 'http://api.test', fetch: impl, onUnauthorized }).get('/kits'),
      );
      expect(err.code).toBe(code);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(onUnauthorized.mock.calls[0]![0]).toMatchObject({ code });
    },
  );

  it('does not treat a wrong password as a lost session', async () => {
    const onUnauthorized = vi.fn();
    const { impl } = fakeFetch(
      apiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect'),
    );
    await errorOf(
      createApiClient({ baseUrl: 'http://api.test', fetch: impl, onUnauthorized }).post(
        '/auth/login',
        {},
      ),
    );
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('does not call it for other failures', async () => {
    const onUnauthorized = vi.fn();
    const { impl } = fakeFetch(
      apiError(403, 'CSRF_ORIGIN_REJECTED', 'no'),
      apiError(500, 'INTERNAL_ERROR', 'x'),
    );
    const client = createApiClient({ baseUrl: 'http://api.test', fetch: impl, onUnauthorized });
    await errorOf(client.post('/kits', {}));
    await errorOf(client.get('/kits'));
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('the auth endpoints', () => {
  it('me() unwraps the user and login() and register() post to the right paths', async () => {
    const user = { id: 'u1', email: 'a@example.com' };
    const { impl, calls } = fakeFetch(
      json(200, { user }),
      json(200, { user }),
      json(201, { user }),
    );
    const auth = createAuthApi(createApiClient({ baseUrl: 'http://api.test', fetch: impl }));
    expect(await auth.me()).toEqual(user);
    expect(await auth.login({ email: 'a@example.com', password: 'pw' })).toEqual(user);
    expect(
      await auth.register({ email: 'a@example.com', password: 'a long enough password' }),
    ).toEqual(user);
    expect(calls.map((c) => `${c.init.method} ${c.url.replace('http://api.test', '')}`)).toEqual([
      'GET /auth/me',
      'POST /auth/login',
      'POST /auth/register',
    ]);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      email: 'a@example.com',
      password: 'pw',
    });
  });

  it('logout() resolves with nothing', async () => {
    const { impl } = fakeFetch(new Response(null, { status: 204 }));
    const auth = createAuthApi(createApiClient({ baseUrl: 'http://api.test', fetch: impl }));
    expect(await auth.logout()).toBeUndefined();
  });

  it('passes server errors such as EMAIL_TAKEN through unchanged', async () => {
    const { impl } = fakeFetch(
      apiError(409, 'EMAIL_TAKEN', 'An account with this email already exists'),
    );
    const auth = createAuthApi(createApiClient({ baseUrl: 'http://api.test', fetch: impl }));
    const err = await errorOf(
      auth.register({ email: 'a@example.com', password: 'a long enough password' }),
    );
    expect(err).toMatchObject({ status: 409, code: 'EMAIL_TAKEN' });
  });
});
