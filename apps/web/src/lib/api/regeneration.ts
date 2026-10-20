import type { RegenerationRequest } from '@trao/contracts';
import { ApiError, type ApiClient, type RequestOptions } from './client';
import type { JobView, SubmitResult } from './jobs';

/**
 * The server refused to start the regeneration because a source it needs is missing. No job exists.
 * `reason` is the server's section-specific code; the message is its explanation.
 */
export class RegenerationRefused extends ApiError {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(422, 'REGENERATION_UNAVAILABLE', message);
    this.name = 'RegenerationRefused';
  }
}

/** Another regeneration for this kit is already running; `jobId` is that job. */
export class RegenerationInProgress extends ApiError {
  constructor(
    message: string,
    readonly jobId: string,
  ) {
    super(409, 'REGENERATION_IN_PROGRESS', message);
    this.name = 'RegenerationInProgress';
  }
}

export interface RegenerationApi {
  start(
    kitId: string,
    request: RegenerationRequest,
    options?: RequestOptions,
  ): Promise<SubmitResult>;
}

const JOB_ID = /^[0-9a-f]{24}$/i;
const STATUSES = ['queued', 'running', 'succeeded', 'failed'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createRegenerationApi(client: ApiClient): RegenerationApi {
  return {
    start: async (kitId, request, options) => {
      let body: unknown;
      try {
        body = await client.post<unknown>(
          `/kits/${encodeURIComponent(kitId)}/regenerations`,
          request,
          options,
        );
      } catch (error) {
        if (error instanceof ApiError) {
          const details = isRecord(error.details) ? error.details : {};
          if (error.status === 422 && error.code === 'REGENERATION_UNAVAILABLE') {
            throw new RegenerationRefused(
              error.message,
              typeof details.reason === 'string' ? details.reason : 'UNKNOWN',
            );
          }
          if (error.status === 409 && error.code === 'REGENERATION_IN_PROGRESS') {
            const jobId = details.job_id;
            if (typeof jobId === 'string' && JOB_ID.test(jobId))
              throw new RegenerationInProgress(error.message, jobId);
          }
        }
        throw error;
      }
      const job = isRecord(body) ? body.job : undefined;
      if (
        !isRecord(body) ||
        !isRecord(job) ||
        typeof job.id !== 'string' ||
        !STATUSES.includes(job.status as string) ||
        typeof body.deduplicated !== 'boolean'
      ) {
        throw new ApiError(
          202,
          'BAD_RESPONSE',
          'The server sent a response this page could not read.',
        );
      }
      return { job: job as unknown as JobView, deduplicated: body.deduplicated };
    },
  };
}
