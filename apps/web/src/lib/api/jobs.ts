import type { GenerationRequest, JobStatus } from '@trao/contracts';
import type { ApiClient, RequestOptions } from './client';

/** A generation job as the API shows it. `progress` and `stage` are null until the job reports them. */
export interface JobView {
  id: string;
  status: JobStatus;
  stage: string | null;
  progress: number | null;
  kit_id: string | null;
  error: { code: string; message: string } | null;
  /** What the job does. Absent on responses from servers that predate regeneration (a generation job). */
  kind?: 'generate' | 'regenerate';
  /** For a finished regeneration: what was kept, replaced, added and skipped. Checked by the reader. */
  report?: unknown;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface SubmitResult {
  job: JobView;
  /** True when an equivalent job was already in progress and is being shown instead of a new one. */
  deduplicated: boolean;
}

export interface JobsApi {
  submit(request: GenerationRequest, options?: RequestOptions): Promise<SubmitResult>;
  get(id: string, options?: RequestOptions): Promise<JobView>;
}

export function createJobsApi(client: ApiClient): JobsApi {
  return {
    submit: (request, options) => client.post<SubmitResult>('/generation-jobs', request, options),
    get: async (id, options) =>
      (await client.get<{ job: JobView }>(`/generation-jobs/${encodeURIComponent(id)}`, options))
        .job,
  };
}
