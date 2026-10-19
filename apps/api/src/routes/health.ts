import { Router } from 'express';
import type { Db } from 'mongodb';

export function healthRouter(db: Db): Router {
  const router = Router();

  // Liveness: the process is up. Does not touch dependencies.
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness: the database answers. Failures are reported without any detail.
  router.get('/ready', async (_req, res) => {
    try {
      await db.command({ ping: 1 });
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  return router;
}
