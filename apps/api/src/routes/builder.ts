import { Router, type RequestHandler } from 'express';
import { operationsRequestSchema, regenerationRequestSchema } from '@trao/contracts';
import type { BuilderService } from '../services/builder.js';
import { toJobView } from '../services/jobs.js';
import type { RegenerationService } from '../services/regeneration.js';

/** Builder endpoints. Every handler passes the authenticated user's id; there is no ownerless path. */
export function builderRouter(deps: {
  builder: BuilderService;
  regeneration: RegenerationService;
  requireAuth: RequestHandler;
}): Router {
  const { builder, regeneration, requireAuth } = deps;
  const router = Router();
  router.use('/kits/:id/builder', requireAuth);
  router.use('/kits/:id/operations', requireAuth);
  router.use('/kits/:id/regenerations', requireAuth);

  router.get('/kits/:id/builder', async (req, res) => {
    res.json(await builder.get(req.user!.objectId, req.params.id));
  });

  router.post('/kits/:id/operations', async (req, res) => {
    const request = operationsRequestSchema.parse(req.body ?? {});
    res.json(await builder.applyOperations(req.user!.objectId, req.params.id, request));
  });

  /** 202 Accepted: the job runs after the response. Poll GET /generation-jobs/:id like any other job. */
  router.post('/kits/:id/regenerations', async (req, res) => {
    const request = regenerationRequestSchema.parse(req.body ?? {});
    const { job, deduplicated } = await regeneration.submit(
      req.user!.objectId,
      req.params.id,
      request,
    );
    res
      .status(202)
      .location(`/generation-jobs/${job._id.toHexString()}`)
      .json({ job: toJobView(job), deduplicated });
  });

  return router;
}
