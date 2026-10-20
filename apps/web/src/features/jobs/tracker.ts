import type { JobView } from '../../lib/api/jobs';
import { ApiError } from '../../lib/api/client';

/** How often a running job is asked about. Polite to the API's rate limit even with several jobs. */
export const POLL_INTERVAL_MS = 2_500;
/** Transient failures in a row (network, 429, 5xx) before polling stops and the user is asked. */
export const MAX_CONSECUTIVE_ERRORS = 4;
/** Longest we keep asking. The server gives a job about 90 seconds, so this is generous. */
export const MAX_TRACK_MS = 5 * 60_000;

export type InterruptionReason =
  'network' | 'timeout' | 'not-found' | 'unauthorized' | 'unexpected';

export type JobOutcome =
  | { kind: 'active' }
  | { kind: 'succeeded'; kitId: string }
  | { kind: 'failed'; code: string; message: string };

/**
 * What a job view means. Success is only ever reported for a job the API marks succeeded AND that
 * names its kit; a "succeeded" job without a kit is treated as a failure rather than a dead link.
 */
export function jobOutcome(job: JobView): JobOutcome {
  if (job.status === 'succeeded') {
    return job.kit_id
      ? { kind: 'succeeded', kitId: job.kit_id }
      : { kind: 'failed', code: 'KIT_MISSING', message: '' };
  }
  if (job.status === 'failed') {
    return {
      kind: 'failed',
      code: job.error?.code ?? 'UNKNOWN',
      message: job.error?.message ?? '',
    };
  }
  return { kind: 'active' };
}

const FAILURE_TEXT: Record<string, string> = {
  COMPANY_URL_INVALID: 'The company address could not be used. Check the link and try again.',
  COMPANY_URL_BLOCKED:
    'That company address is not allowed. Use the public website of the company.',
  COMPANY_UNREACHABLE:
    'The company website could not be reached. Check the link, or try again later.',
  COMPANY_BLOCKED_BY_ROBOTS:
    'The company website asks automated tools not to read it, so it could not be researched.',
  COMPANY_RESEARCH_FAILED: 'The company website could not be researched.',
  INVALID_INPUT: 'The job description or company link was not accepted.',
  INVALID_KIT: 'A complete kit could not be produced from this input. Try again.',
  DEADLINE_EXCEEDED: 'This took too long and was stopped. Try again.',
  LLM_NOT_CONFIGURED: 'Kit generation is not set up on the server yet.',
  CONFIGURATION_ERROR: 'Kit generation is not set up correctly on the server.',
  LLM_AUTH_FAILED: 'The server could not sign in to the language model service.',
  LLM_QUOTA_EXHAUSTED: 'The language model service has reached its usage limit. Try again later.',
  LLM_RATE_LIMITED: 'The language model service is busy. Wait a minute and try again.',
  LLM_TIMEOUT: 'The language model took too long to answer. Try again.',
  LLM_UNAVAILABLE: 'The language model service is unavailable right now. Try again later.',
  LLM_INVALID_OUTPUT: 'The language model returned something unusable. Try again.',
  LLM_CONTENT_BLOCKED: 'The language model declined to process this text.',
  LLM_MODEL_NOT_FOUND: 'The configured language model could not be found on the server.',
  LLM_REQUEST_REJECTED: 'The language model rejected the request.',
  SERVER_RESTARTED: 'The server restarted while this was running. Please submit it again.',
  JOB_TIMED_OUT:
    'This stopped before it finished because the server ended it. Please submit it again.',
  INTERNAL_ERROR: 'Something went wrong on the server. Please try again.',
  VERSION_CONFLICT:
    'The kit was changed while this was running. Nothing was applied. Review the current kit and run it again.',
  KIT_NOT_FOUND: 'The kit no longer exists in your account.',
  RESEARCH_UNAVAILABLE:
    'The research this kit was built from was not kept, so this section cannot be regenerated.',
  NO_USABLE_PAGES:
    'None of the stored company pages has readable text, so this section cannot be regenerated.',
  NO_COMPANY_EVIDENCE: 'There is no stored company evidence to base these questions on.',
  NO_REQUIREMENTS_FOR_CATEGORY:
    'The kit has no requirements of the right kind for these questions.',
  BRIEF_NOT_VERIFIED:
    'A new brief could not be verified against the stored pages, so the existing brief was kept.',
  NOTHING_TO_GENERATE: 'There was nothing to generate for this section.',
  NO_QUESTIONS_GENERATED:
    'The model produced no usable questions, so the existing questions were kept.',
  REGENERATION_REJECTED:
    'The regenerated material could not be merged into the kit, so nothing was changed.',
  REGENERATION_NOT_AVAILABLE: 'Regeneration is not available on this server.',
  KIT_MISSING: 'The job finished but its kit could not be found. Please try again.',
};

/**
 * Plain-language wording for a failed job. Known codes use our own text; an unknown code falls back
 * to the server's message, which the API keeps curated (internals are never stored in a job).
 */
export function describeJobFailure(code: string, serverMessage: string): string {
  return (
    FAILURE_TEXT[code] ?? (serverMessage || 'The kit could not be generated. Please try again.')
  );
}

const STAGE_TEXT: Record<string, string> = {
  starting: 'Starting',
  researching: 'Researching the company',
  generating: 'Writing the kit',
  finalizing: 'Checking and saving the kit',
};

/** The stage the server reported, in words. Null when it has not reported one. */
export function describeStage(job: JobView): string | null {
  if (job.status === 'queued') return 'Waiting to start';
  if (!job.stage) return null;
  return STAGE_TEXT[job.stage] ?? job.stage.replace(/[-_]+/g, ' ');
}

export function interruptionMessage(reason: InterruptionReason): string {
  switch (reason) {
    case 'network':
      return 'We lost contact with the server. The job may still be running.';
    case 'timeout':
      return 'This is taking longer than expected. The job may still be running.';
    case 'not-found':
      return 'That job could not be found. It may belong to another account, or the link may be wrong.';
    case 'unauthorized':
      return 'Your session ended. Sign in again to see this job.';
    default:
      return 'Something unexpected happened while checking on this job.';
  }
}

// ---- tracking state -------------------------------------------------------------------------

export type TrackState =
  | { phase: 'tracking'; job: JobView | null }
  | { phase: 'finished'; job: JobView }
  | { phase: 'interrupted'; reason: InterruptionReason; job: JobView | null };

export type TrackAction =
  | { type: 'update'; job: JobView }
  | { type: 'interrupted'; reason: InterruptionReason }
  | { type: 'resume' };

export const initialTrackState: TrackState = { phase: 'tracking', job: null };

export function trackReducer(state: TrackState, action: TrackAction): TrackState {
  // A finished job never changes again, whatever late response arrives.
  if (state.phase === 'finished') return state;
  switch (action.type) {
    case 'update':
      return jobOutcome(action.job).kind === 'active'
        ? { phase: 'tracking', job: action.job }
        : { phase: 'finished', job: action.job };
    case 'interrupted':
      return { phase: 'interrupted', reason: action.reason, job: state.job };
    case 'resume':
      return state.phase === 'interrupted' ? { phase: 'tracking', job: state.job } : state;
  }
}

// ---- the polling loop -----------------------------------------------------------------------

export type TrackResult =
  | { type: 'finished'; job: JobView }
  | { type: 'interrupted'; reason: InterruptionReason }
  | { type: 'aborted' };

export interface TrackOptions {
  signal: AbortSignal;
  onUpdate: (job: JobView) => void;
  /** Replaced in tests. Must resolve early when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  maxErrors?: number;
  maxMs?: number;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

function isTransient(error: ApiError): boolean {
  return error.status === 0 || error.status === 429 || error.status >= 500;
}

/**
 * Asks about a job until it reaches a final state, one request at a time (never overlapping), then
 * stops. It also stops, without retrying forever, when the session is gone, the job does not exist,
 * contact keeps failing, or it has been going on too long. Aborting the signal ends it quietly.
 */
export async function trackJob(
  api: { get(id: string, options?: { signal?: AbortSignal }): Promise<JobView> },
  jobId: string,
  options: TrackOptions,
): Promise<TrackResult> {
  const {
    signal,
    onUpdate,
    sleep = abortableSleep,
    now = Date.now,
    intervalMs = POLL_INTERVAL_MS,
    maxErrors = MAX_CONSECUTIVE_ERRORS,
    maxMs = MAX_TRACK_MS,
  } = options;
  const started = now();
  let errors = 0;

  for (;;) {
    if (signal.aborted) return { type: 'aborted' };
    try {
      const job = await api.get(jobId, { signal });
      if (signal.aborted) return { type: 'aborted' };
      errors = 0;
      onUpdate(job);
      if (jobOutcome(job).kind !== 'active') return { type: 'finished', job };
    } catch (error) {
      if (signal.aborted) return { type: 'aborted' };
      if (!(error instanceof ApiError)) return { type: 'interrupted', reason: 'unexpected' };
      if (error.code === 'ABORTED') return { type: 'aborted' };
      if (error.status === 401) return { type: 'interrupted', reason: 'unauthorized' };
      if (error.status === 404) return { type: 'interrupted', reason: 'not-found' };
      if (!isTransient(error)) return { type: 'interrupted', reason: 'unexpected' };
      errors += 1;
      if (errors >= maxErrors) return { type: 'interrupted', reason: 'network' };
    }
    if (now() - started >= maxMs) return { type: 'interrupted', reason: 'timeout' };
    // Back off after a failure instead of hammering a struggling server.
    await sleep(errors === 0 ? intervalMs : intervalMs * 2 ** errors, signal);
  }
}
