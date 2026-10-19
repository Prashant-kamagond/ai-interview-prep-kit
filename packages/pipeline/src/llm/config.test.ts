import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { LlmError } from './errors.js';
import { loadLlmConfig } from './config.js';

const KEY = 'test-key-0123456789-abcdefghijklmnop';

describe('loadLlmConfig', () => {
  it('fails with a clear configuration error when the key is missing', () => {
    for (const env of [{}, { LLM_API_KEY: '' }, { LLM_API_KEY: '   ' }]) {
      try {
        loadLlmConfig(env);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LlmError);
        expect((err as LlmError).code).toBe('MISSING_CREDENTIALS');
        expect((err as LlmError).message).toMatch(/LLM_API_KEY/);
        expect((err as LlmError).message).toMatch(/README|AI Studio/i);
      }
    }
  });

  it('applies documented defaults, including the candidate model', () => {
    const c = loadLlmConfig({ LLM_API_KEY: KEY });
    expect(c).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      thinkingLevel: 'low',
      maxRetries: 3,
      maxConcurrency: 2,
      minIntervalMs: 0,
    });
    expect(c.requestTimeoutMs).toBeGreaterThanOrEqual(30_000);
  });

  it('takes the model, limits and thinking level from the environment, and never substitutes', () => {
    const c = loadLlmConfig({
      LLM_API_KEY: KEY,
      LLM_MODEL: 'gemini-3.5-flash-lite',
      LLM_REQUEST_TIMEOUT_MS: '45000',
      LLM_MAX_RETRIES: '1',
      LLM_MAX_CONCURRENCY: '1',
      LLM_MIN_INTERVAL_MS: '2000',
      LLM_THINKING_LEVEL: 'medium',
    });
    expect(c).toMatchObject({
      model: 'gemini-3.5-flash-lite',
      requestTimeoutMs: 45_000,
      maxRetries: 1,
      maxConcurrency: 1,
      minIntervalMs: 2000,
      thinkingLevel: 'medium',
    });
  });

  it('treats empty values as unset, so a copied .env with blank lines still works', () => {
    const c = loadLlmConfig({
      LLM_API_KEY: KEY,
      LLM_MODEL: '',
      LLM_THINKING_LEVEL: '  ',
      LLM_MAX_RETRIES: '',
      LLM_PROVIDER: '',
    });
    expect(c).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      thinkingLevel: 'low',
      maxRetries: 3,
    });
  });

  it('accepts a model written with the models/ prefix', () => {
    expect(loadLlmConfig({ LLM_API_KEY: KEY, LLM_MODEL: 'models/gemini-3.8-flash' }).model).toBe(
      'gemini-3.8-flash',
    );
  });

  it('rejects an unknown provider instead of silently using another', () => {
    expect(() => loadLlmConfig({ LLM_API_KEY: KEY, LLM_PROVIDER: 'openai' })).toThrow(
      /LLM_PROVIDER/,
    );
  });

  it.each([
    ['LLM_REQUEST_TIMEOUT_MS', 'soon'],
    ['LLM_REQUEST_TIMEOUT_MS', '0'],
    ['LLM_MAX_RETRIES', '-1'],
    ['LLM_MAX_RETRIES', '50'],
    ['LLM_MAX_CONCURRENCY', '0'],
    ['LLM_MAX_CONCURRENCY', '99'],
    ['LLM_THINKING_LEVEL', 'extreme'],
    ['LLM_MODEL', 'a model with spaces'],
  ])('rejects invalid %s=%s, naming the variable but not echoing values', (name, value) => {
    try {
      loadLlmConfig({ LLM_API_KEY: KEY, [name]: value });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain(name);
      expect((err as Error).message).not.toContain(KEY);
    }
  });

  it('rejects a key that could inject headers', () => {
    expect(() => loadLlmConfig({ LLM_API_KEY: 'abc\r\nx-evil: 1' })).toThrow(LlmError);
    expect(() => loadLlmConfig({ LLM_API_KEY: 'has space inside' })).toThrow(LlmError);
  });

  it('keeps the key out of JSON, logs and inspection output', () => {
    const c = loadLlmConfig({ LLM_API_KEY: KEY });
    expect(c.apiKey).toBe(KEY);
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(inspect(c)).not.toContain(KEY);
    expect(String(Object.keys(c))).not.toContain('apiKey');
  });

  it('never puts the key in an error message', () => {
    try {
      loadLlmConfig({ LLM_API_KEY: KEY, LLM_MAX_RETRIES: 'many' });
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(KEY);
    }
  });
});
