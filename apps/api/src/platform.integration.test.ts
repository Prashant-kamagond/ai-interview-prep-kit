import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { client, createHarness, signUp, type Harness } from './test/harness.js';

describe('platform behaviour', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('reports liveness and readiness', async () => {
    expect((await request(h.app).get('/health')).body).toEqual({ status: 'ok' });
    const ready = await request(h.app).get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ready' });
  });

  it('returns structured JSON for unknown routes and sets a request id', async () => {
    const res = await request(h.app).get('/nope').set('X-Request-Id', 'abc-12345678');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', request_id: 'abc-12345678' });
    expect(res.headers['x-request-id']).toBe('abc-12345678');
  });

  it('replaces a malicious inbound request id with a generated one', async () => {
    const res = await request(h.app).get('/nope').set('X-Request-Id', 'bad id\twith spaces');
    expect(res.headers['x-request-id']).toMatch(/^[\w-]{8,64}$/);
  });

  it('sets security headers and disables caching of API responses', async () => {
    const res = await request(h.app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('allows CORS only for the configured web origin, with credentials', async () => {
    const ok = await request(h.app)
      .options('/kits')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');

    const evil = await request(h.app).get('/health').set('Origin', 'http://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  describe('indexes', () => {
    async function indexes(collection: string) {
      return Object.fromEntries(
        (await h.db.collection(collection).listIndexes().toArray()).map((i) => [i.name, i]),
      );
    }

    it('enforces unique emails', async () => {
      expect((await indexes('users')).email_unique).toMatchObject({
        key: { email: 1 },
        unique: true,
      });
    });

    it('expires sessions with a TTL index and supports lookup by user', async () => {
      const idx = await indexes('sessions');
      expect(idx.expiresAt_ttl).toMatchObject({ key: { expiresAt: 1 }, expireAfterSeconds: 0 });
      expect(idx.userId).toMatchObject({ key: { userId: 1 } });
    });

    it('supports ownership-scoped kit listing', async () => {
      expect((await indexes('kits')).userId_updatedAt).toMatchObject({
        key: { userId: 1, updatedAt: -1 },
      });
    });

    it('allows only one active job per user and input hash, at the database level', async () => {
      const idx = await indexes('generation_jobs');
      expect(idx.active_job_per_input_unique).toMatchObject({
        key: { userId: 1, inputHash: 1 },
        unique: true,
        partialFilterExpression: { active: true },
      });
      expect(idx.userId_createdAt).toMatchObject({ key: { userId: 1, createdAt: -1 } });
      expect(idx.active_jobs).toMatchObject({
        key: { createdAt: 1 },
        partialFilterExpression: { active: true },
      });
    });

    it('rejects a second active job for the same input even if the application check is bypassed', async () => {
      const col = h.db.collection('generation_jobs');
      const doc = { userId: 'u1' as never, inputHash: 'h1', active: true };
      await col.insertOne({ ...doc });
      await expect(col.insertOne({ ...doc })).rejects.toMatchObject({ code: 11000 });
      await expect(col.insertOne({ ...doc, active: false })).resolves.toBeDefined();
      await expect(col.insertOne({ ...doc, active: false })).resolves.toBeDefined();
    });

    it('is idempotent: creating indexes again does not fail', async () => {
      const { ensureIndexes } = await import('./db.js');
      await expect(ensureIndexes(h.db)).resolves.toBeUndefined();
    });
  });
});

describe('database failure', () => {
  it('returns a generic 500 without leaking driver, host or stack details', async () => {
    const broken = await createHarness();
    try {
      const c = await signUp(broken.app);
      await broken.breakConnection();

      const res = await c.get('/kits');
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(res.body.error.message).toBe('Something went wrong. Please try again.');
      expect(res.body.error.request_id).toEqual(expect.any(String));
      expect(JSON.stringify(res.body)).not.toMatch(
        /mongo|topology|pool|connect|ECONN|localhost|27018|\.ts|stack|at /i,
      );
    } finally {
      await broken.close();
    }
  });

  it('reports not-ready when the database is unreachable', async () => {
    const broken = await createHarness();
    try {
      await broken.breakConnection();
      const res = await client(broken.app).get('/ready');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: 'unavailable' });
    } finally {
      await broken.close();
    }
  });
});
