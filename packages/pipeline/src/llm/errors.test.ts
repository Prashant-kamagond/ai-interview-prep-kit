import { describe, expect, it } from 'vitest';
import { LlmError, isFatalForRun, type LlmErrorCode } from './errors.js';

const ALL: LlmErrorCode[] = [
  'MISSING_CREDENTIALS',
  'AUTH_FAILED',
  'INVALID_REQUEST',
  'MODEL_NOT_FOUND',
  'QUOTA_EXHAUSTED',
  'RATE_LIMITED',
  'TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'NETWORK_ERROR',
  'CONTENT_BLOCKED',
  'OUTPUT_TRUNCATED',
  'INVALID_OUTPUT',
  'BUDGET_EXHAUSTED',
];

describe('LlmError', () => {
  it('is retryable only for transient failures', () => {
    const retryable = ALL.filter((code) => new LlmError(code).retryable);
    expect(retryable.sort()).toEqual([
      'NETWORK_ERROR',
      'PROVIDER_UNAVAILABLE',
      'RATE_LIMITED',
      'TIMEOUT',
    ]);
  });

  it('has a safe, actionable default message for every code', () => {
    for (const code of ALL) {
      const message = new LlmError(code).message;
      expect(message.length, code).toBeGreaterThan(10);
      expect(message, code).not.toMatch(/AIza|api[_-]?key=|Bearer|stack|at .*\.ts/i);
    }
    expect(new LlmError('MISSING_CREDENTIALS').message).toMatch(/LLM_API_KEY/);
    expect(new LlmError('MODEL_NOT_FOUND', { model: 'gemini-x' }).message).toContain('gemini-x');
  });

  it('records attempts, retry-after, status and a sanitised provider detail', () => {
    const err = new LlmError('RATE_LIMITED', {
      retryAfterMs: 3000,
      status: 429,
      detail: 'slow down',
    });
    expect(err).toMatchObject({
      attempts: 1,
      retryAfterMs: 3000,
      status: 429,
      detail: 'slow down',
    });
    expect(err.name).toBe('LlmError');
  });

  it('marks credentials, auth, request, model, quota and budget failures as fatal for the whole run', () => {
    const fatal = ALL.filter((code) => isFatalForRun(new LlmError(code)));
    expect(fatal.sort()).toEqual([
      'AUTH_FAILED',
      'BUDGET_EXHAUSTED',
      'INVALID_REQUEST',
      'MISSING_CREDENTIALS',
      'MODEL_NOT_FOUND',
      'QUOTA_EXHAUSTED',
    ]);
  });

  it('treats non-LLM errors as not fatal here (they are bugs and propagate separately)', () => {
    expect(isFatalForRun(new Error('x'))).toBe(false);
  });
});
