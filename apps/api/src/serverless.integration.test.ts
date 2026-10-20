import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import pino from 'pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobFailure, type JobRunner } from './jobs/runner.js';
import { createServerlessApp, type ServerlessApp, type ServerlessDeps } from './serverless.js';
import { STALE_JOB_ERROR } from './services/jobs.js';
import {
  PASSWORD,
  TEST_MONGODB_URI,
  createHarness,
  signUp,
  testConfig,
  uniqueEmail,
} from './test/harness.js';

/**
 * The API the way Vercel runs it: an exported Express app behind the platform's /api route, in production
 * mode, with a real MongoDB. The platform's behaviour (route, prefix stripping, waitUntil) is simulated
 * from what vercel.json declares; only a deployment can confirm the platform really does it.
 */

const ORIGIN = 'https://app.example.com';
const vercelJson = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as {
  services: { api: { routes: { src: string; transforms: { args: string }[] }[] } };
};
const rule = vercelJson.services.api.routes[0]!;
/** What the Express app sees for a public path, according to vercel.json. */
const seenByApi = (publicPath: string) =>
  publicPath.replace(new RegExp(`^${rule.src}$`), rule.transforms[0]!.args);

let client: MongoClient;
let db: Db;
let dbName: string;
let built: ServerlessApp | undefined;

beforeEach(async () => {
  client = new MongoClient(TEST_MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  dbName = `trao_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  db = client.db(dbName);
});

afterEach(async () => {
  await built?.context.jobs.settled();
  built = undefined;
  await client.db(dbName).dropDatabase();
  await client.close();
});

function build(overrides: Partial<ServerlessDeps> = {}): ServerlessApp {
  built = createServerlessApp({
    db,
    config: testConfig({
      nodeEnv: 'production',
      isProduction: true,
      webOrigin: ORIGIN,
      trustProxy: 1,
      sessionSecret: randomBytes(32).toString('hex'),
    }),
    logger: pino({ level: 'silent' }),
    ...overrides,
  });
  return built;
}

const jobBody = {
  jd: 'Backend engineer.\nMust know Node.js and MongoDB.',
  company_url: 'https://example.com/',
  days: 3,
};

/** Registers over "https" and returns the Cookie header to send (a Secure cookie is not replayed over http). */
async function register(app: ServerlessApp['app']) {
  const res = await request(app)
    .post('/auth/register')
    .set('Origin', ORIGIN)
    .set('X-Forwarded-Proto', 'https')
    .send({ email: uniqueEmail(), password: PASSWORD });
  expect(res.status).toBe(201);
  const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0]!;
  return { cookie: setCookie.split(';')[0]!, setCookie, userId: res.body.user.id as string };
}

describe('routing through the platform prefix', () => {
  it.each([
    ['/api/health', 200],
    ['/api/auth/me', 401],
    ['/api/kits', 401],
    ['/api/kits/abc/builder', 401],
    ['/api/kits/abc/practice', 401],
    ['/api/generation-jobs/abc', 401],
  ])('%s reaches a real Express route after the prefix is stripped (%i)', async (path, status) => {
    const { app } = build();
    const res = await request(app).get(seenByApi(path));
    expect(res.status).toBe(status);
    expect(res.body?.error?.code).not.toBe('NOT_FOUND');
  });

  it('strips the /api prefix itself when the platform has not (the first deployment showed it may not)', async () => {
    const { app } = build();
    expect((await request(app).get('/api/health')).status).toBe(200);
    expect((await request(app).get('/api/health?probe=1')).status).toBe(200);
    expect((await request(app).get('/api/kits')).status).toBe(401);
  });

  it('answers the same routes when the platform did strip the prefix', async () => {
    const { app } = build();
    expect((await request(app).get('/health')).status).toBe(200);
    expect((await request(app).get('/kits')).status).toBe(401);
  });

  it('only removes one leading /api: a path that merely contains it is not a route', async () => {
    const { app } = build();
    expect((await request(app).get('/api/api/kits')).status).toBe(404);
    expect((await request(app).get('/apix/kits')).status).toBe(404);
  });
});

describe('readiness of the database', () => {
  it('prepares the database once per instance, not once per request', async () => {
    const prepare = vi.fn(async () => undefined);
    const { app } = build({ prepare });
    await Promise.all([1, 2, 3].map(() => request(app).get('/auth/me')));
    await request(app).get('/kits');
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('answers /health without touching the database, and 503 for the rest while it is unavailable', async () => {
    const prepare = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED mongodb://admin:hunter2@internal-host:27017');
    });
    const { app } = build({ prepare });
    expect((await request(app).get('/health')).status).toBe(200);
    expect(prepare).not.toHaveBeenCalled();

    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|ECONNREFUSED|internal-host/);
  });

  it('recovers on the next request once the database is back', async () => {
    let calls = 0;
    const { app } = build({
      prepare: async () => {
        if (++calls === 1) throw new Error('down');
      },
    });
    expect((await request(app).get('/auth/me')).status).toBe(503);
    expect((await request(app).get('/auth/me')).status).toBe(401);
    expect(calls).toBe(2);
  });

  it('creates the real indexes by default', async () => {
    const { app } = build();
    await request(app).get('/auth/me');
    const names = (await db.collection('generation_jobs').indexes()).map((i) => i.name);
    expect(names).toContain('active_job_per_input_unique');
  });
});

describe('authentication and cookies in production mode', () => {
  it('sets a __Host- cookie that is Secure, HttpOnly, SameSite=Lax, Path=/ and has no Domain', async () => {
    const { app } = build();
    const { setCookie } = await register(app);
    expect(setCookie).toMatch(/^__Host-sid=/);
    expect(setCookie).toMatch(/;\s*Secure/i);
    expect(setCookie).toMatch(/;\s*HttpOnly/i);
    expect(setCookie).toMatch(/;\s*SameSite=Lax/i);
    expect(setCookie).toMatch(/;\s*Path=\//i);
    expect(setCookie).not.toMatch(/Domain=/i);
  });

  it('accepts the session cookie, and refuses a write from any other origin', async () => {
    const { app } = build();
    const { cookie } = await register(app);
    expect((await request(app).get('/auth/me').set('Cookie', cookie)).status).toBe(200);
    const wrong = await request(app)
      .post('/generation-jobs')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:3000')
      .send(jobBody);
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('CSRF_ORIGIN_REJECTED');
  });

  it('allows CORS only for the configured origin', async () => {
    const { app } = build();
    const ok = await request(app).get('/health').set('Origin', ORIGIN);
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const other = await request(app).get('/health').set('Origin', 'https://evil.example.com');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('job lifecycle on a platform that ends invocations', () => {
  const failing: JobRunner = {
    async run() {
      throw new JobFailure('COMPANY_UNREACHABLE', 'Company site unreachable.');
    },
  };

  it('asks the platform to keep the invocation alive until the job has recorded its outcome', async () => {
    const tasks: Promise<void>[] = [];
    const { app } = build({ runner: failing, keepAlive: (task) => void tasks.push(task) });
    const { cookie } = await register(app);

    const res = await request(app)
      .post('/generation-jobs')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .send(jobBody);
    expect(res.status).toBe(202);
    expect(tasks).toHaveLength(1);

    await tasks[0];
    const job = await request(app).get(`/generation-jobs/${res.body.job.id}`).set('Cookie', cookie);
    expect(job.body.job.status).toBe('failed');
    expect(job.body.job.error.code).toBe('COMPANY_UNREACHABLE');
  });

  it('keeps working if the platform call itself throws', async () => {
    const { app } = build({
      runner: failing,
      keepAlive: () => {
        throw new Error('no request context');
      },
    });
    const { cookie } = await register(app);
    const res = await request(app)
      .post('/generation-jobs')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .send(jobBody);
    expect(res.status).toBe(202);
  });

  it('does not sweep jobs at start: a job another instance is running stays running', async () => {
    const { app, context } = build({ runner: failing });
    const { cookie, userId } = await register(app);
    const { job } = await context.repos.jobs.insertActive({
      userId: new ObjectId(userId),
      inputHash: 'running-elsewhere',
      input: jobBody,
    });
    await request(app).get('/kits').set('Cookie', cookie);
    const res = await request(app).get(`/generation-jobs/${job._id}`).set('Cookie', cookie);
    expect(res.body.job.status).toBe('queued');
  });

  it('fails a job nobody has updated for longer than the limit, when it is read', async () => {
    const { app, context } = build({ runner: failing, staleAfterMs: 60_000 });
    const { cookie, userId } = await register(app);
    const stale = await context.repos.jobs.insertActive({
      userId: new ObjectId(userId),
      inputHash: 'stale',
      input: jobBody,
    });
    const fresh = await context.repos.jobs.insertActive({
      userId: new ObjectId(userId),
      inputHash: 'fresh',
      input: jobBody,
    });
    await db
      .collection('generation_jobs')
      .updateOne({ _id: stale.job._id }, { $set: { updatedAt: new Date(Date.now() - 120_000) } });

    const old = await request(app).get(`/generation-jobs/${stale.job._id}`).set('Cookie', cookie);
    expect(old.body.job.status).toBe('failed');
    expect(old.body.job.error).toEqual({ ...STALE_JOB_ERROR });
    expect(old.body.job.finished_at).toBeTruthy();

    const recent = await request(app)
      .get(`/generation-jobs/${fresh.job._id}`)
      .set('Cookie', cookie);
    expect(recent.body.job.status).toBe('queued');
  });

  it("does not let abandoned jobs use up a user's limit of active jobs", async () => {
    const { app, context } = build({ runner: failing, staleAfterMs: 60_000 });
    const { cookie, userId } = await register(app);
    for (const n of [1, 2, 3]) {
      await context.repos.jobs.insertActive({
        userId: new ObjectId(userId),
        inputHash: `abandoned-${n}`,
        input: jobBody,
      });
    }
    await db
      .collection('generation_jobs')
      .updateMany({}, { $set: { updatedAt: new Date(Date.now() - 120_000) } });

    const res = await request(app)
      .post('/generation-jobs')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .send(jobBody);
    expect(res.status).toBe(202);
  });

  it('the long-running server (no limit set) never fails a job because of its age', async () => {
    const h = await createHarness();
    try {
      const c = await signUp(h.app);
      const me = await c.get('/auth/me');
      const { job } = await h.repos.jobs.insertActive({
        userId: new ObjectId(me.body.user.id),
        inputHash: 'old-but-running',
        input: jobBody,
      });
      await h.db
        .collection('generation_jobs')
        .updateOne(
          { _id: job._id },
          { $set: { updatedAt: new Date(Date.now() - 24 * 3_600_000) } },
        );
      const res = await c.get(`/generation-jobs/${job._id}`);
      expect(res.body.job.status).toBe('queued');
    } finally {
      await h.close();
    }
  });
});
