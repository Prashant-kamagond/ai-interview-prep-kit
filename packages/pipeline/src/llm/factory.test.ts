import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadLlmConfig } from './config.js';
import { createLlmClientFromConfig } from './factory.js';
import { LlmError } from './errors.js';

const KEY = 'test-key-0123456789-abcdefghijklmnop';

function fakeFetch(reply: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return reply();
  }) as typeof fetch;
  return { impl, calls };
}

const ok = () =>
  new Response(
    JSON.stringify({
      status: 'completed',
      model: 'models/gemini-3.8-flash',
      usage: { total_input_tokens: 10, total_output_tokens: 5, total_thought_tokens: 2 },
      steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"a":"x"}' }] }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('createLlmClientFromConfig', () => {
  it('builds a Gemini client for the configured model, sending the key only in a header', async () => {
    const config = loadLlmConfig({
      LLM_API_KEY: KEY,
      LLM_MODEL: 'gemini-3.8-flash',
      LLM_THINKING_LEVEL: 'medium',
    });
    const { impl, calls } = fakeFetch(ok);
    const client = createLlmClientFromConfig(config, { fetch: impl });

    expect(client.model).toBe('gemini-3.8-flash');
    expect(client.providerId).toBe('gemini');
    const out = await client.generateObject({
      stage: 'x',
      system: 's',
      prompt: 'p',
      schema: z.object({ a: z.string() }),
      maxOutputTokens: 100,
    });
    expect(out).toEqual({ a: 'x' });

    const call = calls[0]!;
    expect(call.url).toBe('https://generativelanguage.googleapis.com/v1/interactions');
    expect((call.init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
    expect(call.url).not.toContain(KEY);
    expect(String(call.init.body)).not.toContain(KEY);
    expect(JSON.parse(String(call.init.body)).generation_config.thinking_level).toBe('medium');
  });

  it('applies the configured concurrency limit', async () => {
    const config = loadLlmConfig({ LLM_API_KEY: KEY, LLM_MAX_CONCURRENCY: '1' });
    let inFlight = 0;
    let max = 0;
    const impl = (async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return ok();
    }) as unknown as typeof fetch;
    const client = createLlmClientFromConfig(config, { fetch: impl });
    await Promise.all(
      [1, 2, 3].map(() =>
        client.generateObject({
          stage: 'x',
          system: 's',
          prompt: 'p',
          schema: z.object({ a: z.string() }),
          maxOutputTokens: 50,
        }),
      ),
    );
    expect(max).toBe(1);
  });

  it('applies the configured retry budget', async () => {
    const config = loadLlmConfig({ LLM_API_KEY: KEY, LLM_MAX_RETRIES: '1' });
    const { impl, calls } = fakeFetch(() => new Response('{}', { status: 503 }));
    const client = createLlmClientFromConfig(config, {
      fetch: impl,
      clock: { now: () => Date.now(), sleep: async () => undefined },
    });
    const err = await client
      .generateObject({
        stage: 'x',
        system: 's',
        prompt: 'p',
        schema: z.object({ a: z.string() }),
        maxOutputTokens: 50,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe('PROVIDER_UNAVAILABLE');
    expect(calls).toHaveLength(2); // 1 attempt + 1 retry
  });

  it('never makes a request when the key is missing: configuration fails first', () => {
    expect(() => loadLlmConfig({})).toThrow(LlmError);
  });
});
