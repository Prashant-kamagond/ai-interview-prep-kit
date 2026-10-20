import { Router, type RequestHandler } from 'express';
import { practiceAttemptRequestSchema } from '@trao/contracts';
import type { PracticeService } from '../services/practice.js';

/** Practice progress. Every handler passes the authenticated user's id; there is no ownerless path. */
export function practiceRouter(deps: {
  practice: PracticeService;
  requireAuth: RequestHandler;
}): Router {
  const { practice, requireAuth } = deps;
  const router = Router();
  router.use('/kits/:id/practice', requireAuth);

  router.get('/kits/:id/practice', async (req, res) => {
    res.json(await practice.progress(req.user!.objectId, req.params.id));
  });

  router.put('/kits/:id/practice/cards/:cardId', async (req, res) => {
    const body = practiceAttemptRequestSchema.parse(req.body ?? {});
    const { progress, duplicate } = await practice.record(
      req.user!.objectId,
      req.params.id,
      req.params.cardId,
      body,
    );
    res.json({ card: progress, duplicate });
  });

  router.delete('/kits/:id/practice', async (req, res) => {
    await practice.reset(req.user!.objectId, req.params.id);
    res.status(204).end();
  });

  return router;
}
