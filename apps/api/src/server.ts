import { attachDatabasePool } from '@vercel/functions';
import express from 'express';
import { MongoClient } from 'mongodb';
import { loadConfig } from './config.js';
import { createPipelineRunner } from './jobs/pipeline-runner.js';
import { createLogger } from './logger.js';
import { createServerlessApp } from './serverless.js';

/**
 * Entry point for Vercel (a Vercel Function): the Express app is exported, nothing listens on a port.
 * Locally and for `make dev` the server in `index.ts` is used instead.
 *
 * The settings come from the platform's environment variables (see docs/deployment.md). If they are
 * invalid the function answers every request with a generic 503 and logs the reason, instead of crashing
 * on load.
 */
function build(): express.Express {
  // Before the settings are read there is no configured level; stay quiet only when explicitly asked.
  const logger = createLogger(process.env.LOG_LEVEL === 'silent' ? 'silent' : 'info');
  try {
    const config = loadConfig();
    const log = createLogger(config.logLevel);
    // The driver connects on first use, and keeps a small pool per instance.
    const client = new MongoClient(config.mongodbUri, {
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 5,
    });
    // Lets the platform release idle connections before it suspends the instance.
    attachDatabasePool(client);
    return createServerlessApp({
      db: client.db(),
      config,
      logger: log,
      createRunner: (repos) => createPipelineRunner({ repos, config, logger: log }),
    }).app;
  } catch (err) {
    logger.error({ err }, 'invalid server configuration');
    const unavailable = express();
    unavailable.use((_req, res) => {
      res.status(503).json({
        error: { code: 'CONFIGURATION_ERROR', message: 'The server is not configured correctly.' },
      });
    });
    return unavailable;
  }
}

export default build();
