import { describe, expect, it } from 'vitest';
import { resolveCreateLlm } from './llm.js';
import { JobFailure } from './runner.js';

/**
 * Generation and regeneration jobs both build their model client with resolveCreateLlm, so this is where the
 * selected provider reaches the API. Building a client makes no request.
 */

const GROQ_KEY = 'gsk_apikey0123456789abcdefghijklmnop';
const GEMINI_KEY = 'gemini-api-key-0123456789-abcdefghijkl';

const clock = { now: () => 0, sleep: async () => undefined };

describe('resolveCreateLlm: provider selection', () => {
  it('builds a Groq client for LLM_PROVIDER=groq', () => {
    const createLlm = resolveCreateLlm({
      env: { LLM_PROVIDER: 'groq', GROQ_API_KEY: GROQ_KEY, LLM_API_KEY: GEMINI_KEY },
    });
    const client = createLlm({ deadline: 60_000, clock });
    expect(client.providerId).toBe('groq');
    expect(client.model).toBe('openai/gpt-oss-20b');
  });

  it('builds a Gemini client by default', () => {
    const client = resolveCreateLlm({ env: { LLM_API_KEY: GEMINI_KEY } })({
      deadline: 60_000,
      clock,
    });
    expect(client.providerId).toBe('gemini');
  });

  it('fails the job as not configured, naming GROQ_API_KEY, without any key value', () => {
    try {
      resolveCreateLlm({ env: { LLM_PROVIDER: 'groq', LLM_API_KEY: GEMINI_KEY } });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(JobFailure);
      expect((err as JobFailure).code).toBe('LLM_NOT_CONFIGURED');
      expect((err as Error).message).toMatch(/GROQ_API_KEY/);
      expect((err as Error).message).not.toContain(GEMINI_KEY);
    }
  });

  it('reports an unsupported model as a configuration error without echoing settings', () => {
    try {
      resolveCreateLlm({
        env: { LLM_PROVIDER: 'groq', GROQ_API_KEY: GROQ_KEY, LLM_MODEL: 'some-other-model' },
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as JobFailure).code).toBe('CONFIGURATION_ERROR');
      expect((err as Error).message).not.toContain(GROQ_KEY);
    }
  });
});
