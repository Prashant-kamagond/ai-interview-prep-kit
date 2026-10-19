import { JOB_STATUSES, type JobStatus } from '@trao/contracts';

/**
 * queued ──► running ──► succeeded
 *    │          │
 *    └──────────┴──────► failed
 *
 * succeeded and failed are terminal. A job can only succeed by passing through running, and no
 * transition ever leaves a terminal state.
 */
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['running', 'failed'],
  running: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: JobStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** The states a job may be in for a transition into `to` to be legal. */
export function allowedSources(to: JobStatus): JobStatus[] {
  return JOB_STATUSES.filter((from) => canTransition(from, to));
}
