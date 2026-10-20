import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * server.ts is the Vercel entry: importing it must build an app from the environment without connecting to
 * anything or listening on a port. A MongoDB client is created lazily, so no database is needed here.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('./db.js');
  vi.resetModules();
});

async function loadEntry() {
  vi.resetModules();
  const mod = await import('./server.js');
  return mod.default;
}

describe('the Vercel entry (server.ts)', () => {
  it('exports an Express app that answers /health without a database', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', 'a-real-looking-random-value-0123456789abcdef');
    vi.stubEnv('MONGODB_URI', 'mongodb://127.0.0.1:1/never-connected?serverSelectionTimeoutMS=200');
    vi.stubEnv('WEB_ORIGIN', 'https://app.example.com');
    vi.stubEnv('LOG_LEVEL', 'silent');
    const app = await loadEntry();
    expect(typeof app).toBe('function');
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('answers 503 for the rest while the database is unreachable, without leaking the address', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', 'a-real-looking-random-value-0123456789abcdef');
    vi.stubEnv('MONGODB_URI', 'mongodb://127.0.0.1:1/never-connected?serverSelectionTimeoutMS=200');
    vi.stubEnv('WEB_ORIGIN', 'https://app.example.com');
    vi.stubEnv('LOG_LEVEL', 'silent');
    vi.doMock('./db.js', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      ensureIndexes: async () => {
        throw new Error('connect ECONNREFUSED mongodb://admin:hunter2@internal-host:27017');
      },
    }));
    const app = await loadEntry();
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|internal-host|ECONNREFUSED/);
  });

  it('with invalid settings answers every request with a generic 503 instead of crashing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', 'too-short');
    vi.stubEnv('MONGODB_URI', 'mongodb://127.0.0.1:1/x');
    vi.stubEnv('LOG_LEVEL', 'silent');
    const app = await loadEntry();
    for (const path of ['/health', '/auth/me', '/kits']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('CONFIGURATION_ERROR');
      expect(JSON.stringify(res.body)).not.toMatch(/SESSION_SECRET|too-short|mongodb/i);
    }
  });
});
