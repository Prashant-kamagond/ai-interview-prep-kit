import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { MongoClient, MongoNetworkError, type Db } from 'mongodb';
import pino from 'pino';
import request from 'supertest';
import { createApp, type AppContext } from '../app.js';
import type { Config } from '../config.js';
import { ensureIndexes } from '../db.js';
import type { JobRunInput, JobRunner } from '../jobs/runner.js';

export const TEST_ORIGIN = 'http://localhost:3000';

/** Defaults match compose.yaml + .env.example. CI points this at an unauthenticated service. */
export const TEST_MONGODB_URI =
  process.env.TEST_MONGODB_URI ??
  'mongodb://trao:change-me-local-only@localhost:27018/?authSource=admin';

export interface Harness extends Omit<AppContext, 'app'> {
  /** The app served on a real ephemeral port, so parallel requests share one listener. */
  app: Server;
  db: Db;
  config: Config;
  /** Closes the app's connection and drops the throwaway database via a fresh connection. */
  close(): Promise<void>;
  /** Simulates the database going away while the app is still serving. */
  breakConnection(): Promise<void>;
}

/**
 * Wraps a Db so every operation throws a driver-style error once `isBroken()` is true. (Closing
 * the client would not work: current drivers reconnect implicitly.) The message deliberately
 * contains internals, so tests can prove none of it reaches a client.
 */
function faultInjectingDb(db: Db, isBroken: () => boolean): Db {
  const failure = () =>
    new MongoNetworkError('connect ECONNREFUSED mongodb://admin:hunter2@internal-host:27018');
  const wrap = <T extends object>(target: T, intercept: (prop: string | symbol) => boolean): T =>
    new Proxy(target, {
      get(t, prop) {
        const value: unknown = Reflect.get(t, prop, t);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (isBroken() && intercept(prop)) throw failure();
          return (value as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    });
  return new Proxy(db, {
    get(t, prop) {
      if (prop === 'collection') {
        return (...args: Parameters<Db['collection']>) => wrap(t.collection(...args), () => true);
      }
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (isBroken() && prop === 'command') throw failure();
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test',
    isProduction: false,
    port: 0,
    webOrigin: TEST_ORIGIN,
    mongodbUri: TEST_MONGODB_URI,
    sessionSecret: `test-secret-${randomBytes(16).toString('hex')}`,
    sessionTtlMs: 3_600_000,
    cookieSameSite: 'lax',
    trustProxy: 0,
    authRateLimitMax: 10_000,
    apiRateLimitMax: 100_000,
    logLevel: 'silent',
    allowPrivateHosts: false,
    ...overrides,
  };
}

export async function createHarness(
  options: { config?: Partial<Config>; runner?: JobRunner } = {},
): Promise<Harness> {
  const client = new MongoClient(TEST_MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
  } catch (err) {
    await client.close().catch(() => undefined);
    throw new Error(
      'MongoDB is not reachable for integration tests. Start it with `docker compose up -d mongo` ' +
        `or set TEST_MONGODB_URI. (${(err as Error).name})`,
      { cause: err },
    );
  }

  const dbName = `trao_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const db = client.db(dbName);
  await ensureIndexes(db);

  const config = testConfig(options.config);
  let broken = false;
  const ctx = createApp({
    db: faultInjectingDb(db, () => broken),
    config,
    logger: pino({ level: 'silent' }),
    ...(options.runner ? { runner: options.runner } : {}),
  });

  const server = createServer(ctx.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    ...ctx,
    app: server,
    db,
    config,
    async breakConnection() {
      broken = true;
    },
    async close() {
      await ctx.jobs.settled();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const cleaner = new MongoClient(TEST_MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
      await cleaner.connect();
      await cleaner.db(dbName).dropDatabase();
      await cleaner.close();
      await client.close().catch(() => undefined);
    },
  };
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomBytes(6).toString('hex')}@example.com`;
}

export const PASSWORD = 'correct horse battery staple';

/** A cookie-keeping client that sends the Origin header browsers send on unsafe requests. */
export function client(app: Server) {
  const agent = request.agent(app);
  return {
    agent,
    get: (url: string) => agent.get(url),
    post: (url: string, body?: object) => agent.post(url).set('Origin', TEST_ORIGIN).send(body),
    put: (url: string, body?: object) => agent.put(url).set('Origin', TEST_ORIGIN).send(body),
    del: (url: string) => agent.delete(url).set('Origin', TEST_ORIGIN),
  };
}

export type TestClient = ReturnType<typeof client>;

export async function signUp(app: Server, email = uniqueEmail()): Promise<TestClient> {
  const c = client(app);
  const res = await c.post('/auth/register', { email, password: PASSWORD });
  if (res.status !== 201)
    throw new Error(`signUp failed: ${res.status} ${JSON.stringify(res.body)}`);
  return c;
}

export async function waitFor<T>(
  fn: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A runner the test controls: blocks until released, then returns the given kit id (or fails). */
export function controllableRunner() {
  const calls: JobRunInput[] = [];
  let release!: (kitId: string) => void;
  let fail!: (err: unknown) => void;
  const gate = new Promise<string>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  const runner: JobRunner = {
    async run(input, ctx) {
      calls.push(input);
      await ctx.report('researching', 25);
      return { kitId: await gate };
    },
  };
  return { runner, calls, release, fail };
}
