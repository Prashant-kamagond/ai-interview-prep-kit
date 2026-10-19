import express from 'express';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // Liveness only; a readiness check that pings MongoDB is added with persistence in Phase 3.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}
