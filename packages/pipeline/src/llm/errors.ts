export type LlmErrorCode =
  | 'MISSING_CREDENTIALS'
  | 'AUTH_FAILED'
  | 'INVALID_REQUEST'
  | 'MODEL_NOT_FOUND'
  | 'QUOTA_EXHAUSTED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'CONTENT_BLOCKED'
  | 'OUTPUT_TRUNCATED'
  | 'INVALID_OUTPUT'
  | 'BUDGET_EXHAUSTED';

/** Worth retrying with backoff: the same request may succeed a moment later. */
const RETRYABLE: ReadonlySet<LlmErrorCode> = new Set([
  'RATE_LIMITED',
  'TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'NETWORK_ERROR',
]);

/**
 * No point continuing the run: every later call would fail the same way (bad key, wrong model,
 * rejected request shape, exhausted quota, no time left).
 */
const FATAL_FOR_RUN: ReadonlySet<LlmErrorCode> = new Set([
  'MISSING_CREDENTIALS',
  'AUTH_FAILED',
  'INVALID_REQUEST',
  'MODEL_NOT_FOUND',
  'QUOTA_EXHAUSTED',
  'BUDGET_EXHAUSTED',
]);

const MESSAGES: Record<LlmErrorCode, string> = {
  MISSING_CREDENTIALS:
    'The LLM API key is not configured. Set LLM_API_KEY (create a key in Google AI Studio; see the README).',
  AUTH_FAILED: 'The LLM provider rejected the API key. Check LLM_API_KEY.',
  INVALID_REQUEST: 'The LLM provider rejected the request as invalid.',
  MODEL_NOT_FOUND: 'The configured model is not available to this API key.',
  QUOTA_EXHAUSTED: 'The LLM provider quota is exhausted. Check your quota in Google AI Studio.',
  RATE_LIMITED: 'The LLM provider rate-limited the request.',
  TIMEOUT: 'The LLM request timed out.',
  PROVIDER_UNAVAILABLE: 'The LLM provider is temporarily unavailable.',
  NETWORK_ERROR: 'The LLM provider could not be reached.',
  CONTENT_BLOCKED: 'The LLM provider declined to process this content.',
  OUTPUT_TRUNCATED: 'The model output was cut off before it was complete.',
  INVALID_OUTPUT: 'The model returned output that failed validation.',
  BUDGET_EXHAUSTED: 'The time budget for generation was used up.',
};

export interface LlmErrorOptions {
  /** Overrides the default safe message. Must not contain provider text, prompts or secrets. */
  message?: string;
  model?: string;
  status?: number;
  retryAfterMs?: number | undefined;
  /** Provider text kept for server-side logs: sanitised and bounded by whoever sets it. */
  detail?: string;
  /** Validation problems (paths and reasons only, never content) for INVALID_OUTPUT. */
  issues?: string[];
  cause?: unknown;
}

/**
 * Every way a model call can fail. `message` is written to be shown to a user: it comes from a
 * fixed table and never contains provider text, prompts, keys or stack traces. `detail` holds the
 * provider's own wording for logs, already redacted and length-bounded.
 */
export class LlmError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly detail: string | undefined;
  readonly issues: string[] | undefined;
  /** How many attempts were made before giving up (set by the retry wrapper). */
  attempts = 1;

  constructor(
    readonly code: LlmErrorCode,
    options: LlmErrorOptions = {},
  ) {
    const base =
      code === 'MODEL_NOT_FOUND' && options.model
        ? `The configured model "${options.model}" is not available to this API key.`
        : MESSAGES[code];
    super(
      options.message ?? base,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'LlmError';
    this.retryable = RETRYABLE.has(code);
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.detail = options.detail;
    this.issues = options.issues;
  }
}

export function isFatalForRun(err: unknown): boolean {
  return err instanceof LlmError && FATAL_FOR_RUN.has(err.code);
}
