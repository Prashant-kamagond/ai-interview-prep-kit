import { Router, type RequestHandler } from 'express';
import { generationRequestSchema } from '@trao/contracts';
import { toJobView, type JobService } from '../services/jobs.js';

export function jobsRouter(deps: { jobs: JobService; requireAuth: RequestHandler }): Router {
  const { jobs, requireAuth } = deps;
  const router = Router();
  router.use('/generation-jobs', requireAuth);

  /**
   * 202 Accepted: the work happens after the response. An equivalent in-progress request returns
   * the existing job with `deduplicated: true` instead of starting a second one.
   */
  router.post('/generation-jobs', async (req, res) => {
    const input = generationRequestSchema.parse(req.body ?? {});
    const { job, deduplicated } = await jobs.submit(req.user!.objectId, input);
    res
      .status(202)
      .location(`/generation-jobs/${job._id.toHexString()}`)
      .json({ job: toJobView(job), deduplicated });
  });

  router.get('/generation-jobs/:id', async (req, res) => {
    res.json({ job: toJobView(await jobs.get(req.user!.objectId, req.params.id)) });
  });

  return router;
}
