import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PASSWORD,
  TEST_ORIGIN,
  client,
  createHarness,
  signUp,
  uniqueEmail,
  type Harness,
} from './test/harness.js';

function sessionCookie(res: request.Response, name = 'sid'): string {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const line = raw.find((c) => c.startsWith(`${name}=`));
  if (!line) throw new Error(`no ${name} cookie in ${JSON.stringify(raw)}`);
  return line;
}

describe('authentication', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('registers a user, signs them in, and never returns hashes or session records', async () => {
    const c = client(h.app);
    const email = uniqueEmail('Reg');
    const res = await c.post('/auth/register', { email, password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({ id: expect.any(String), email: email.toLowerCase() });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash|session/i);

    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Secure/i); // development only; production is tested below

    const me = await c.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email.toLowerCase());
  });

  it('stores an argon2id hash, and a hashed (not raw) session identifier', async () => {
    const c = client(h.app);
    const email = uniqueEmail();
    const res = await c.post('/auth/register', { email, password: PASSWORD });
    const token = sessionCookie(res).split(';')[0]!.split('=')[1]!;

    const user = await h.db.collection('users').findOne({ email });
    expect(user?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(user)).not.toContain(PASSWORD);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await h.db.collection('sessions').findOne({ _id: token as never })).toBeNull();
    const stored = await h.db.collection('sessions').findOne({ userId: user!._id });
    expect(String(stored?._id)).not.toBe(token);
    expect(stored?.expiresAt).toBeInstanceOf(Date);
  });

  it('rejects duplicate emails case-insensitively', async () => {
    const email = uniqueEmail('Dup');
    await signUp(h.app, email);
    const res = await client(h.app).post('/auth/register', {
      email: email.toUpperCase(),
      password: PASSWORD,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('lets exactly one of several concurrent registrations for one email win', async () => {
    const email = uniqueEmail('Race');
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        client(h.app).post('/auth/register', { email, password: PASSWORD }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    // Emails are stored lower-cased.
    expect(await h.db.collection('users').countDocuments({ email: email.toLowerCase() })).toBe(1);
  });

  it.each([
    ['malformed email', { email: 'nope', password: PASSWORD }],
    ['short password', { email: uniqueEmail(), password: 'short' }],
    ['missing fields', {}],
    ['overlong password', { email: uniqueEmail(), password: 'x'.repeat(500) }],
  ])('rejects invalid registration: %s', async (_name, body) => {
    const res = await client(h.app).post('/auth/register', body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual(expect.any(Array));
    expect(res.body.error.request_id).toEqual(expect.any(String));
  });

  it('logs in with valid credentials and issues a new session each time', async () => {
    const email = uniqueEmail();
    await signUp(h.app, email);
    const a = await client(h.app).post('/auth/login', { email, password: PASSWORD });
    const b = await client(h.app).post('/auth/login', { email, password: PASSWORD });
    expect(a.status).toBe(200);
    expect(sessionCookie(a)).not.toBe(sessionCookie(b));
  });

  it('gives identical responses for a wrong password and an unknown email', async () => {
    const email = uniqueEmail();
    await signUp(h.app, email);
    const wrong = await client(h.app).post('/auth/login', { email, password: 'wrong-password-1' });
    const unknown = await client(h.app).post('/auth/login', {
      email: uniqueEmail('ghost'),
      password: 'wrong-password-1',
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('logs out: the session is deleted server-side and the cookie is cleared', async () => {
    const c = await signUp(h.app);
    const before = await h.db.collection('sessions').countDocuments();
    const out = await c.post('/auth/logout');
    expect(out.status).toBe(204);
    expect(sessionCookie(out)).toMatch(/sid=;/);
    expect(await h.db.collection('sessions').countDocuments()).toBe(before - 1);
    expect((await c.get('/auth/me')).status).toBe(401);
  });

  it('invalidates a session when the stolen cookie is replayed after logout', async () => {
    const email = uniqueEmail();
    const res = await client(h.app).post('/auth/register', { email, password: PASSWORD });
    const cookie = sessionCookie(res).split(';')[0]!;
    await request(h.app).post('/auth/logout').set('Origin', TEST_ORIGIN).set('Cookie', cookie);
    const replay = await request(h.app).get('/auth/me').set('Cookie', cookie);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('treats a garbage cookie as unauthenticated and clears it', async () => {
    for (const value of ['garbage', 'a'.repeat(43), '%00%00']) {
      const res = await request(h.app).get('/auth/me').set('Cookie', `sid=${value}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('reports an expired session as SESSION_EXPIRED, then removes the record', async () => {
    const email = uniqueEmail();
    const c = await signUp(h.app, email);
    const user = await h.db.collection('users').findOne({ email });
    const sessions = h.db.collection('sessions');
    await sessions.updateMany(
      { userId: user!._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const first = await c.get('/auth/me');
    expect(first.status).toBe(401);
    expect(first.body.error.code).toBe('SESSION_EXPIRED');
    expect(await sessions.countDocuments({ userId: user!._id })).toBe(0);

    // The cookie was cleared and the record is gone, so a retry is simply unauthenticated.
    expect((await request(h.app).get('/auth/me')).body.error.code).toBe('UNAUTHENTICATED');
  });

  it.each([
    ['get', '/auth/me'],
    ['get', '/kits'],
    ['post', '/kits'],
    ['get', '/kits/abc'],
    ['put', '/kits/abc'],
    ['delete', '/kits/abc'],
    ['post', '/generation-jobs'],
    ['get', '/generation-jobs/abc'],
  ] as const)('rejects unauthenticated %s %s', async (method, path) => {
    const res = await request(h.app)[method](path).set('Origin', TEST_ORIGIN).send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  describe('CSRF origin check', () => {
    it.each([
      ['a foreign Origin', 'http://evil.example'],
      ['a look-alike Origin', `${TEST_ORIGIN}.evil.example`],
    ])('rejects state-changing requests with %s', async (_n, origin) => {
      const res = await request(h.app)
        .post('/auth/login')
        .set('Origin', origin)
        .send({ email: uniqueEmail(), password: PASSWORD });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_ORIGIN_REJECTED');
    });

    it('rejects state-changing requests with no Origin header', async () => {
      const res = await request(h.app)
        .post('/auth/login')
        .send({ email: uniqueEmail(), password: PASSWORD });
      expect(res.status).toBe(403);
    });

    it('does not require Origin for safe methods', async () => {
      expect((await request(h.app).get('/health')).status).toBe(200);
    });
  });
});

describe('authentication hardening', () => {
  it('rate limits credential endpoints with a structured error', async () => {
    const h = await createHarness({ config: { authRateLimitMax: 3 } });
    try {
      const attempt = () =>
        client(h.app).post('/auth/login', { email: uniqueEmail(), password: 'wrong-password-1' });
      for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
      const limited = await attempt();
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
      expect(limited.body.error.request_id).toEqual(expect.any(String));
    } finally {
      await h.close();
    }
  });

  it('uses a __Host- prefixed Secure HttpOnly cookie in production', async () => {
    const h = await createHarness({ config: { nodeEnv: 'production', isProduction: true } });
    try {
      const res = await client(h.app).post('/auth/register', {
        email: uniqueEmail(),
        password: PASSWORD,
      });
      const cookie = sessionCookie(res, '__Host-sid');
      expect(cookie).toMatch(/; Secure/i);
      expect(cookie).toMatch(/; HttpOnly/i);
      expect(cookie).toMatch(/; Path=\//i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).not.toMatch(/Domain=/i);
    } finally {
      await h.close();
    }
  });
});
