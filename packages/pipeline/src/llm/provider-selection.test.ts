import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadLlmConfig } from './config.js';
import { LlmError } from './errors.js';
import { createLlmClientFromConfig } from './factory.js';
import { GROQ_DEFAULT_MODEL, GROQ_STRICT_MODELS } from './groq.js';

const GEMINI_KEY = 'gemini-key-0123456789-abcdefghijklmnop';
const GROQ_KEY = 'gsk_groqkey0123456789abcdefghijklmnop';

describe('loadLlmConfig: provider selection', () => {
  it('defaults to Gemini and reads LLM_API_KEY', () => {
    const c = loadLlmConfig({ LLM_API_KEY: GEMINI_KEY });
    expect(c).toMatchObject({ provider: 'gemini', model: 'gemini-3.8-flash' });
    expect(c.apiKey).toBe(GEMINI_KEY);
  });

  it('selects Gemini explicitly', () => {
    const c = loadLlmConfig({ LLM_PROVIDER: 'gemini', LLM_API_KEY: GEMINI_KEY });
    expect(c.provider).toBe('gemini');
  });

  it('selects Groq, reads GROQ_API_KEY and defaults to a documented strict-output model', () => {
    const c = loadLlmConfig({ LLM_PROVIDER: 'groq', GROQ_API_KEY: GROQ_KEY });
    expect(c).toMatchObject({ provider: 'groq', model: GROQ_DEFAULT_MODEL });
    expect(GROQ_STRICT_MODELS).toContain(GROQ_DEFAULT_MODEL);
    expect(c.apiKey).toBe(GROQ_KEY);
  });

  it('accepts a configured Groq model id that contains a slash', () => {
    const c = loadLlmConfig({
      LLM_PROVIDER: 'groq',
      GROQ_API_KEY: GROQ_KEY,
      LLM_MODEL: 'openai/gpt-oss-120b',
    });
    expect(c.model).toBe('openai/gpt-oss-120b');
  });

  it('keeps the shared limits for Groq', () => {
    const c = loadLlmConfig({
      LLM_PROVIDER: 'groq',
      GROQ_API_KEY: GROQ_KEY,
      LLM_REQUEST_TIMEOUT_MS: '45000',
      LLM_MAX_RETRIES: '1',
      LLM_MAX_CONCURRENCY: '1',
      LLM_MIN_INTERVAL_MS: '2000',
      LLM_THINKING_LEVEL: 'medium',
    });
    expect(c).toMatchObject({
      requestTimeoutMs: 45_000,
      maxRetries: 1,
      maxConcurrency: 1,
      minIntervalMs: 2000,
      thinkingLevel: 'medium',
    });
    expect(() =>
      loadLlmConfig({ LLM_PROVIDER: 'groq', GROQ_API_KEY: GROQ_KEY, LLM_MAX_RETRIES: '50' }),
    ).toThrow(/LLM_MAX_RETRIES/);
  });

  it('requires GROQ_API_KEY for Groq and names it', () => {
    for (const env of [{ LLM_PROVIDER: 'groq' }, { LLM_PROVIDER: 'groq', GROQ_API_KEY: '  ' }]) {
      try {
        loadLlmConfig(env);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LlmError);
        expect((err as LlmError).code).toBe('MISSING_CREDENTIALS');
        expect((err as Error).message).toMatch(/GROQ_API_KEY/);
        expect((err as Error).message).not.toMatch(/AI Studio/);
      }
    }
  });

  it('never uses the Gemini key for Groq, nor the Groq key for Gemini', () => {
    expect(() => loadLlmConfig({ LLM_PROVIDER: 'groq', LLM_API_KEY: GEMINI_KEY })).toThrow(
      /GROQ_API_KEY/,
    );
    expect(() => loadLlmConfig({ GROQ_API_KEY: GROQ_KEY })).toThrow(/LLM_API_KEY/);
    expect(() => loadLlmConfig({ LLM_PROVIDER: 'gemini', GROQ_API_KEY: GROQ_KEY })).toThrow(
      /LLM_API_KEY/,
    );
  });

  it('with both keys present, uses the key of the selected provider', () => {
    const both = { LLM_API_KEY: GEMINI_KEY, GROQ_API_KEY: GROQ_KEY };
    expect(loadLlmConfig({ ...both, LLM_PROVIDER: 'groq' }).apiKey).toBe(GROQ_KEY);
    expect(loadLlmConfig({ ...both, LLM_PROVIDER: 'gemini' }).apiKey).toBe(GEMINI_KEY);
    expect(loadLlmConfig(both).apiKey).toBe(GEMINI_KEY);
  });

  it('does not silently fall back to Gemini when Groq was requested without a key', () => {
    expect(() => loadLlmConfig({ LLM_PROVIDER: 'groq', LLM_API_KEY: GEMINI_KEY })).toThrow(
      LlmError,
    );
  });

  it.each(['openai', 'GROQ', 'Gemini', 'groq '.repeat(2)])(
    'rejects the unsupported provider "%s" without echoing the key',
    (provider) => {
      try {
        loadLlmConfig({ LLM_PROVIDER: provider, LLM_API_KEY: GEMINI_KEY, GROQ_API_KEY: GROQ_KEY });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as Error).message).toMatch(/LLM_PROVIDER/);
        expect((err as Error).message).not.toContain(GEMINI_KEY);
        expect((err as Error).message).not.toContain(GROQ_KEY);
      }
    },
  );

  it('rejects a Groq model without documented strict structured output, naming the fix', () => {
    try {
      loadLlmConfig({
        LLM_PROVIDER: 'groq',
        GROQ_API_KEY: GROQ_KEY,
        LLM_MODEL: 'llama-3.3-70b-versatile',
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/LLM_MODEL/);
      expect((err as Error).message).toMatch(/openai\/gpt-oss-20b/);
      expect((err as Error).message).not.toContain(GROQ_KEY);
    }
  });

  it('rejects a malformed Groq model id, and a Gemini-only id shape is not accepted for Gemini', () => {
    expect(() =>
      loadLlmConfig({ LLM_PROVIDER: 'groq', GROQ_API_KEY: GROQ_KEY, LLM_MODEL: 'a b' }),
    ).toThrow(/LLM_MODEL/);
    expect(() =>
      loadLlmConfig({ LLM_API_KEY: GEMINI_KEY, LLM_MODEL: 'openai/gpt-oss-20b' }),
    ).toThrow(/LLM_MODEL/);
  });

  it('rejects a Groq key that could inject headers, naming the right variable', () => {
    try {
      loadLlmConfig({ LLM_PROVIDER: 'groq', GROQ_API_KEY: 'abc\r\nx-evil: 1' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as LlmError).code).toBe('MISSING_CREDENTIALS');
      expect((err as Error).message).toMatch(/GROQ_API_KEY/);
    }
  });

  it('keeps the Groq key out of JSON, logs and inspection output', () => {
    const c = loadLlmConfig({ LLM_PROVIDER: 'groq', GROQ_API_KEY: GROQ_KEY });
    expect(JSON.stringify(c)).not.toContain(GROQ_KEY);
    expect(inspect(c)).not.toContain(GROQ_KEY);
    expect(Object.keys(c)).not.toContain('apiKey');
  });
});

describe('createLlmClientFromConfig: provider selection', () => {
  function recordingFetch(body: unknown) {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    return { impl, calls };
  }
  const args = {
    stage: 'x',
    system: 's',
    prompt: 'p',
    schema: z.object({ a: z.string() }),
    maxOutputTokens: 100,
  };

  it('builds Groq for LLM_PROVIDER=groq and never contacts Gemini', async () => {
    const config = loadLlmConfig({
      LLM_PROVIDER: 'groq',
      GROQ_API_KEY: GROQ_KEY,
      LLM_API_KEY: GEMINI_KEY,
    });
    const { impl, calls } = recordingFetch({
      model: 'openai/gpt-oss-20b',
      choices: [{ finish_reason: 'stop', message: { content: '{"a":"x"}' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    });
    const events: unknown[] = [];
    const client = createLlmClientFromConfig(config, {
      fetch: impl,
      onEvent: (e) => events.push(e),
    });
    expect(client.providerId).toBe('groq');
    expect(client.model).toBe(GROQ_DEFAULT_MODEL);
    expect(await client.generateObject(args)).toEqual({ a: 'x' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    for (const call of calls) {
      expect(call.url).not.toContain('googleapis');
      expect(JSON.stringify(call.init.headers)).not.toContain(GEMINI_KEY);
      expect(JSON.stringify(call.init.headers)).toContain(GROQ_KEY);
    }
    expect(events).toHaveLength(1); // optional callbacks still work
  });

  it('builds Gemini for the default and never contacts Groq', async () => {
    const config = loadLlmConfig({ LLM_API_KEY: GEMINI_KEY, GROQ_API_KEY: GROQ_KEY });
    const { impl, calls } = recordingFetch({
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"a":"x"}' }] }],
    });
    const client = createLlmClientFromConfig(config, { fetch: impl });
    expect(client.providerId).toBe('gemini');
    await client.generateObject(args);
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1/interactions');
    expect(JSON.stringify(calls[0]!.init)).not.toContain(GROQ_KEY);
  });

  it('applies the configured concurrency to Groq too', async () => {
    const config = loadLlmConfig({
      LLM_PROVIDER: 'groq',
      GROQ_API_KEY: GROQ_KEY,
      LLM_MAX_CONCURRENCY: '1',
    });
    let inFlight = 0;
    let max = 0;
    const impl = (async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"a":"x"}' } }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    const client = createLlmClientFromConfig(config, { fetch: impl });
    await Promise.all([client.generateObject(args), client.generateObject(args)]);
    expect(max).toBe(1);
  });

  it('fails safely for a provider no code supports', () => {
    const config = loadLlmConfig({ LLM_API_KEY: GEMINI_KEY });
    const bad = Object.create(config, {
      provider: { value: 'openai' },
      apiKey: { value: GEMINI_KEY },
    });
    try {
      createLlmClientFromConfig(bad, {});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as LlmError).code).toBe('INVALID_REQUEST');
      expect((err as Error).message).not.toContain(GEMINI_KEY);
    }
  });
});
