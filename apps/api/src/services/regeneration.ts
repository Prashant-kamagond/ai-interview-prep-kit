import { createHash } from 'node:crypto';
import type { ObjectId } from 'mongodb';
import type { RegenerationRequest } from '@trao/contracts';
import { checkRegenerationSources } from '@trao/pipeline';
import { AppError } from '../errors.js';
import type { JobDoc } from '../models.js';
import type { Repositories } from '../repositories/index.js';
import { researchOf } from './builder-support.js';
import type { BuilderService } from './builder.js';
import type { JobService } from './jobs.js';

/** Identifies "this section of this kit", so an identical request that is still running is not started twice. */
export function hashRegeneration(kitId: string, request: RegenerationRequest): string {
  const canonical = JSON.stringify([
    'regenerate-v1',
    kitId,
    request.section,
    request.section === 'questions' ? request.category : null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export function createRegenerationService(deps: {
  repos: Pick<Repositories, 'jobs'>;
  jobs: Pick<JobService, 'submitRegeneration'>;
  builder: Pick<BuilderService, 'load'>;
}) {
  return {
    /**
     * Starts a regeneration, or refuses it at once. Ownership is enforced by loading the kit as the
     * caller (a missing or foreign kit is a 404). A section whose sources are missing is refused with
     * a section-specific reason BEFORE any job exists, so nothing is queued that cannot work.
     */
    async submit(
      userId: ObjectId,
      kitId: string,
      request: RegenerationRequest,
    ): Promise<{ job: JobDoc; deduplicated: boolean }> {
      const { oid, doc } = await deps.builder.load(userId, kitId);

      const check = checkRegenerationSources(request, doc.kit, researchOf(doc));
      if (!check.ok) {
        throw new AppError(422, 'REGENERATION_UNAVAILABLE', check.message, {
          reason: check.code,
          section: request.section,
          ...(request.section === 'questions' ? { category: request.category } : {}),
        });
      }

      // One regeneration at a time per kit: a second one would only race the first for the kit's version.
      const hash = hashRegeneration(oid.toHexString(), request);
      const active = await deps.repos.jobs.findActiveRegeneration(userId, oid);
      if (active && active.inputHash !== hash) {
        throw new AppError(
          409,
          'REGENERATION_IN_PROGRESS',
          'Another regeneration for this kit is still running. Wait for it to finish, then try again.',
          { job_id: active._id.toHexString() },
        );
      }
      return deps.jobs.submitRegeneration(userId, { kitId: oid, request }, hash);
    },
  };
}

export type RegenerationService = ReturnType<typeof createRegenerationService>;
