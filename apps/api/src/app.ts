import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import type { Db } from 'mongodb';
import type { Config } from './config.js';
import { unimplementedRunner, type JobRunner } from './jobs/runner.js';
import type { Logger } from './logger.js';
import { requireAuth } from './middleware/authenticate.js';
import { errorHandler, routeNotFound } from './middleware/error-handler.js';
import { originCheck } from './middleware/origin-check.js';
import { createLimiter } from './middleware/rate-limit.js';
import { requestContext } from './middleware/request-context.js';
import { createRepositories, type Repositories } from './repositories/index.js';
import { authRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';
import { jobsRouter } from './routes/jobs.js';
import { builderRouter } from './routes/builder.js';
import { practiceRouter } from './routes/practice.js';
import { createPracticeService } from './services/practice.js';
import { kitsRouter } from './routes/kits.js';
import { createAuthService } from './services/auth.js';
import { createJobService, type JobService } from './services/jobs.js';
import { createBuilderService } from './services/builder.js';
import { createRegenerationService } from './services/regeneration.js';
import {
  createRegenerationRunner,
  type RegenerationRunnerOptions,
} from './jobs/regeneration-runner.js';
import { createKitService } from './services/kits.js';

export interface AppDeps {
  db: Db;
  config: Config;
  logger: Logger;
  /** The generation implementation. Defaults to one that fails every job honestly. */
  runner?: JobRunner;
  /** Builds the runner once the repositories exist (the real pipeline needs them to store kits). Wins over `runner`. */
  createRunner?: (repos: Repositories) => JobRunner;
  /** Model and time settings for regeneration jobs (tests inject a fake model client). */
  regeneration?: Pick<RegenerationRunnerOptions, 'createLlm' | 'env' | 'deadlineMs'>;
}

export interface AppContext {
  app: express.Express;
  jobs: JobService;
  repos: Repositories;
}

const AUTH_WINDOW_MS = 15 * 60_000;
const API_WINDOW_MS = 60_000;

export function createApp({
  db,
  config,
  logger,
  runner = unimplementedRunner,
  createRunner,
  regeneration: regenerationOptions = {},
}: AppDeps): AppContext {
  const repos = createRepositories(db);
  const auth = createAuthService(repos, config);
  const kits = createKitService(repos, logger);
  const builder = createBuilderService(repos, logger);
  const regenerationRunner = createRegenerationRunner({
    repos,
    builder,
    logger,
    ...regenerationOptions,
  });
  const jobs = createJobService(
    repos,
    createRunner ? createRunner(repos) : runner,
    logger,
    regenerationRunner,
  );
  const regeneration = createRegenerationService({ repos, jobs, builder });
  const practice = createPracticeService(repos);
  const authenticated = requireAuth(auth, config);

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);

  app.use(requestContext(logger));
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  // Strict allow-list: the CORS headers are emitted only for the configured web origin.
  app.use(
    cors({
      origin: (origin, callback) => callback(null, origin === config.webOrigin),
      credentials: true,
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(originCheck(config.webOrigin));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use(healthRouter(db));

  app.use(createLimiter(config.apiRateLimitMax, API_WINDOW_MS));
  app.use(
    authRouter({
      auth,
      config,
      credentialLimiter: createLimiter(config.authRateLimitMax, AUTH_WINDOW_MS),
      requireAuth: authenticated,
    }),
  );
  app.use(kitsRouter({ kits, requireAuth: authenticated }));
  app.use(builderRouter({ builder, regeneration, requireAuth: authenticated }));
  app.use(practiceRouter({ practice, requireAuth: authenticated }));
  app.use(jobsRouter({ jobs, requireAuth: authenticated }));

  app.use(routeNotFound);
  app.use(errorHandler(logger));

  return { app, jobs, repos };
}
