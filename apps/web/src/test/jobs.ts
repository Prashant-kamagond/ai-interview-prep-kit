import type { JobView } from '../lib/api/jobs';

/** A job as the API shows it; override only what a test cares about. */
export function job(over: Partial<JobView> = {}): JobView {
  return {
    id: 'a'.repeat(24),
    status: 'running',
    stage: 'researching',
    progress: 5,
    kit_id: null,
    error: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    started_at: null,
    finished_at: null,
    ...over,
  };
}
