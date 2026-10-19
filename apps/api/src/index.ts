import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { connectMongo, ensureIndexes } from './db.js';
import { createLogger } from './logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const client = await connectMongo(config.mongodbUri);
  const db = client.db();
  await ensureIndexes(db);

  const { app, jobs } = createApp({ db, config, logger });

  // Jobs run in this process and cannot be resumed after a restart; fail the orphans honestly.
  const orphaned = await jobs.failInterrupted();
  if (orphaned > 0) logger.warn({ orphaned }, 'marked interrupted generation jobs as failed');

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, 'api listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void jobs
        .settled()
        .then(() => client.close())
        .then(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // Config errors never contain secret values; other startup errors are logged by name/message.
  console.error('failed to start:', err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
