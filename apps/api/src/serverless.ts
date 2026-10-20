import { waitUntil } from '@vercel/functions';
import express from 'express';
import type { Db } from 'mongodb';
import type { Logger } from 'pino';
import { createApp, type AppContext, type AppDeps } from './app.js';
import type { Config } from './config.js';
import { ensureIndexes } from './db.js';
import { SERVERLESS_JOB_STALE_AFTER_MS } from './serverless-limits.js';

/**
 * The API as a request handler for a platform that runs it per request (Vercel Functions), instead of a
 * process that listens on a port (`index.ts`, used by `make dev`).
 *
 * What differs from the long-running server:
 *  - nothing listens: the app is exported and the platform calls it;
 *  - the database is prepared (indexes) lazily, once per instance, before the first request that needs it.
 *    A failure is reported as 503 and retried by the next request;
 *  - there is no startup sweep that fails every active job: another instance may be running a job right now.
 *    Jobs nobody is running any more are failed after a timeout instead (`staleAfterMs`);
 *  - a job asks the platform to keep the invocation alive until it finishes (`keepAlive`). That is a request,
 *    not a guarantee, which is why the stale-job recovery exists.
 */

/**
 * Asks the platform to keep the current invocation alive until the task settles (Vercel's documented
 * `waitUntil`, from the official `@vercel/functions` package). It is a request, not a guarantee: the
 * invocation can still be ended (for example at the duration limit), which is what the stale-job recovery
 * covers. Outside Vercel (tests, `make dev`) there is no request context and the call does nothing.
 */
export function platformKeepAlive(task: Promise<void>): void {
  waitUntil(task);
}

export interface ServerlessDeps extends Pick<AppDeps, 'runner' | 'createRunner' | 'regeneration'> {
  db: Db;
  config: Config;
  logger: Logger;
  /** Prepares the database once per instance. Defaults to creating the indexes (idempotent). */
  prepare?: (db: Db) => Promise<void>;
  keepAlive?: (task: Promise<void>) => void;
  staleAfterMs?: number;
  now?: () => number;
}

export interface ServerlessApp {
  app: express.Express;
  context: AppContext;
  /** Resolves when the database is prepared; rejects (and will be retried) when it could not be. */
  ensureReady(): Promise<void>;
}

export function createServerlessApp(deps: ServerlessDeps): ServerlessApp {
  const prepare = deps.prepare ?? ensureIndexes;
  let ready: Promise<void> | undefined;
  const ensureReady = (): Promise<void> =>
    (ready ??= prepare(deps.db).catch((err: unknown) => {
      ready = undefined; // try again on the next request
      throw err;
    }));

  const context = createApp({
    db: deps.db,
    config: deps.config,
    logger: deps.logger,
    ...(deps.runner ? { runner: deps.runner } : {}),
    ...(deps.createRunner ? { createRunner: deps.createRunner } : {}),
    ...(deps.regeneration ? { regeneration: deps.regeneration } : {}),
    jobOptions: {
      keepAlive: deps.keepAlive ?? platformKeepAlive,
      staleAfterMs: deps.staleAfterMs ?? SERVERLESS_JOB_STALE_AFTER_MS,
      ...(deps.now ? { now: deps.now } : {}),
    },
  });

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    // Liveness never touches the database.
    if (req.path === '/health') return next();
    ensureReady().then(
      () => next(),
      (err: unknown) => {
        deps.logger.error({ err }, 'database is not ready');
        res.status(503).json({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message:
              'The service is starting or its database is unavailable. Please try again shortly.',
          },
        });
      },
    );
  });
  app.use(context.app);

  return { app, context, ensureReady };
}
