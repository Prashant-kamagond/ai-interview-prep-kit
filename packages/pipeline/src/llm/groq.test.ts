import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLlmClient } from './client.js';
import { LlmError, type LlmErrorCode } from './errors.js';
import { createGroqProvider } from './groq.js';
import type { LlmRequest } from './types.js';

const KEY = 'gsk_testkey0123456789abcdefghijklmnop';
const MODEL = 'openai/gpt-oss-20b';

const request = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  system: 'You extract data.',
  prompt: 'Extract the skill.',
  schema: {
    type: 'object',
    properties: { skill: { type: 'string' } },
    required: ['skill'],
    additionalProperties: false,
  },
  maxOutputTokens: 300,
  timeoutMs: 2000,
  ...over,
});

const completion = (over: Record<string, unknown> = {}, choice: Record<string, unknown> = {}) => ({
  model: MODEL,
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: '{"skill":"sql"}' },
      ...choice,
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
  ...over,
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function setup(
  reply: Response | ((n: number) => Response | Promise<Response>),
  options: Record<string, unknown> = {},
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return typeof reply === 'function' ? reply(calls.length) : reply.clone();
  }) as typeof fetch;
  const provider = createGroqProvider({ apiKey: KEY, model: MODEL, fetch: impl, ...options });
  return { provider, calls };
}

async function failure(provider: { generate(r: LlmRequest): Promise<unknown> }, req = request()) {
  try {
    await provider.generate(req);
  } catch (err) {
    expect(err).toBeInstanceOf(LlmError);
    return err as LlmError;
  }
  throw new Error('expected generate() to fail');
}

describe('createGroqProvider: request', () => {
  it('posts to the documented endpoint with a Bearer key, the model and strict json_schema', async () => {
    const { provider, calls } = setup(json(completion()));
    const res = await provider.generate(request());
    expect(res.text).toBe('{"skill":"sql"}');

    const call = calls[0]!;
    expect(call.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(call.init.body));
    expect(body.model).toBe(MODEL);
    expect(body.messages).toEqual([
      { role: 'system', content: 'You extract data.' },
      { role: 'user', content: 'Extract the skill.' },
    ]);
    expect(body.max_completion_tokens).toBe(300);
    expect(body.reasoning_effort).toBe('low');
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', strict: true, schema: request().schema },
    });
  });

  it('keeps the key out of the URL and the body', async () => {
    const { provider, calls } = setup(json(completion()));
    await provider.generate(request());
    expect(calls[0]!.url).not.toContain(KEY);
    expect(String(calls[0]!.init.body)).not.toContain(KEY);
  });

  it('sends no Gemini-only parameters', async () => {
    const { provider, calls } = setup(json(completion()));
    await provider.generate(request());
    const body = String(calls[0]!.init.body);
    for (const gemini of ['thinking_level', 'generation_config', 'system_instruction', 'store']) {
      expect(body).not.toContain(gemini);
    }
  });

  it.each([
    ['minimal', 'low'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
  ] as const)(
    'maps thinking level %s to reasoning_effort %s for gpt-oss',
    async (level, effort) => {
      const { provider, calls } = setup(json(completion()), { thinkingLevel: level });
      await provider.generate(request());
      expect(JSON.parse(String(calls[0]!.init.body)).reasoning_effort).toBe(effort);
    },
  );

  it('uses the "none" effort Qwen documents for minimal, and omits gpt-oss-only fields', async () => {
    const { provider, calls } = setup(json(completion()), {
      model: 'qwen/qwen3.8-27b',
      thinkingLevel: 'minimal',
    });
    await provider.generate(request());
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.reasoning_effort).toBe('none');
    expect(body).not.toHaveProperty('include_reasoning');
  });

  it('refuses a model without documented strict structured output, naming what to change', () => {
    try {
      createGroqProvider({ apiKey: KEY, model: 'llama-3.3-70b-versatile' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as LlmError).code).toBe('INVALID_REQUEST');
      expect((err as Error).message).toMatch(/LLM_MODEL/);
      expect((err as Error).message).not.toContain(KEY);
    }
  });

  it('makes exactly one request per call (retries belong to the shared client)', async () => {
    const { provider, calls } = setup(json({ error: { message: 'busy' } }, 503));
    await failure(provider);
    expect(calls).toHaveLength(1);
  });
});

describe('createGroqProvider: response', () => {
  it('returns text, usage and the model the provider reports', async () => {
    const { provider } = setup(json(completion({ model: 'openai/gpt-oss-20b-2' })));
    expect(await provider.generate(request())).toEqual({
      text: '{"skill":"sql"}',
      model: 'openai/gpt-oss-20b-2',
      usage: { inputTokens: 12, outputTokens: 7, thoughtTokens: 0 },
    });
  });

  it('reads reasoning tokens only when Groq reports them', async () => {
    const { provider } = setup(
      json(
        completion({
          usage: {
            prompt_tokens: 1,
            completion_tokens: 9,
            completion_tokens_details: { reasoning_tokens: 4 },
          },
        }),
      ),
    );
    expect((await provider.generate(request())).usage.thoughtTokens).toBe(4);
  });

  it('treats missing usage as zero instead of inventing numbers', async () => {
    const body = completion() as Record<string, unknown>;
    delete body.usage;
    const { provider } = setup(json(body));
    expect((await provider.generate(request())).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      thoughtTokens: 0,
    });
  });

  it('treats malformed usage as zero instead of inventing numbers', async () => {
    const { provider } = setup(
      json(completion({ usage: { prompt_tokens: 'many', completion_tokens: -3 } })),
    );
    expect((await provider.generate(request())).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      thoughtTokens: 0,
    });
  });

  it('falls back to the configured model when none is reported', async () => {
    const body = completion() as Record<string, unknown>;
    delete body.model;
    const { provider } = setup(json(body));
    expect((await provider.generate(request())).model).toBe(MODEL);
  });

  it.each([
    ['no choices', { choices: [] }, {}, 'INVALID_OUTPUT'],
    ['choices missing', { choices: undefined }, {}, 'INVALID_OUTPUT'],
    ['empty content', {}, { message: { role: 'assistant', content: '  ' } }, 'INVALID_OUTPUT'],
    ['null content', {}, { message: { role: 'assistant', content: null } }, 'INVALID_OUTPUT'],
    ['cut off', {}, { finish_reason: 'length' }, 'OUTPUT_TRUNCATED'],
    ['filtered', {}, { finish_reason: 'content_filter' }, 'CONTENT_BLOCKED'],
    [
      'a refusal',
      {},
      { message: { role: 'assistant', content: null, refusal: 'I cannot help with that.' } },
      'CONTENT_BLOCKED',
    ],
    ['an odd finish reason', {}, { finish_reason: 'tool_calls' }, 'INVALID_OUTPUT'],
  ] as [string, Record<string, unknown>, Record<string, unknown>, LlmErrorCode][])(
    'maps %s to %s',
    async (_name, over, choice, code) => {
      const { provider } = setup(json(completion(over, choice)));
      expect((await failure(provider)).code).toBe(code);
    },
  );

  it('returns malformed JSON text unchanged so the shared client can repair it', async () => {
    const { provider } = setup(
      json(completion({}, { message: { role: 'assistant', content: '{"skill": ' } })),
    );
    expect((await provider.generate(request())).text).toBe('{"skill": ');
  });

  it('reports an unreadable success body as a retryable provider problem', async () => {
    const { provider } = setup(new Response('<html>gateway</html>', { status: 200 }));
    const err = await failure(provider);
    expect(err.code).toBe('PROVIDER_UNAVAILABLE');
    expect(err.retryable).toBe(true);
  });
});

describe('createGroqProvider: errors', () => {
  const cases: [string, number, Record<string, unknown>, LlmErrorCode, boolean][] = [
    ['bad key', 401, { error: { message: 'Invalid API Key' } }, 'AUTH_FAILED', false],
    ['forbidden', 403, { error: { message: 'no' } }, 'AUTH_FAILED', false],
    ['billing', 402, { error: { message: 'pay' } }, 'QUOTA_EXHAUSTED', false],
    ['unknown model', 404, { error: { message: 'no such model' } }, 'MODEL_NOT_FOUND', false],
    [
      'decommissioned',
      400,
      { error: { message: 'gone', code: 'model_decommissioned' } },
      'MODEL_NOT_FOUND',
      false,
    ],
    ['invalid request', 400, { error: { message: 'bad field' } }, 'INVALID_REQUEST', false],
    ['too large', 413, { error: { message: 'big' } }, 'INVALID_REQUEST', false],
    ['unprocessable', 422, { error: { message: 'odd' } }, 'INVALID_REQUEST', false],
    [
      'schema mismatch',
      400,
      { error: { message: 'does not match', code: 'json_validate_failed' } },
      'INVALID_OUTPUT',
      false,
    ],
    ['server error', 500, { error: { message: 'oops' } }, 'PROVIDER_UNAVAILABLE', true],
    ['bad gateway', 502, {}, 'PROVIDER_UNAVAILABLE', true],
    ['overloaded', 503, { error: { message: 'busy' } }, 'PROVIDER_UNAVAILABLE', true],
    ['flex capacity', 498, { error: { message: 'full' } }, 'PROVIDER_UNAVAILABLE', true],
  ];
  it.each(cases)('maps %s (HTTP %i) to %s', async (_n, status, body, code, retryable) => {
    const { provider } = setup(json(body, status));
    const err = await failure(provider);
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
    expect(err.status).toBe(status);
  });

  it("names Groq's own variable and console, not Gemini's", async () => {
    const auth = await failure(setup(json({ error: { message: 'x' } }, 401)).provider);
    expect(auth.message).toMatch(/GROQ_API_KEY/);
    const quota = await failure(setup(json({ error: { message: 'x' } }, 402)).provider);
    expect(quota.message).toMatch(/Groq console/);
    for (const m of [auth.message, quota.message]) expect(m).not.toMatch(/LLM_API_KEY|AI Studio/);
  });

  it('treats a per-minute 429 as a retryable rate limit and reads Retry-After', async () => {
    const { provider } = setup(
      json({ error: { message: 'Rate limit reached ... tokens per minute (TPM)' } }, 429, {
        'retry-after': '7',
      }),
    );
    const err = await failure(provider);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(7000);
  });

  it.each([
    [
      'wording',
      { error: { message: 'Rate limit reached ... on tokens per day (TPD): Limit 100000' } },
      {},
    ],
    ['a very long wait', { error: { message: 'Rate limit reached' } }, { 'retry-after': '36000' }],
  ])('treats a daily 429 (%s) as an exhausted quota, not retried', async (_n, body, headers) => {
    const { provider } = setup(json(body, 429, headers));
    const err = await failure(provider);
    expect(err.code).toBe('QUOTA_EXHAUSTED');
    expect(err.retryable).toBe(false);
  });

  it('reports a network failure as retryable and does not leak the key', async () => {
    const { provider } = setup(() => {
      throw new TypeError(`connect ECONNREFUSED while sending Bearer ${KEY}`);
    });
    const err = await failure(provider);
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.retryable).toBe(true);
    expect(`${err.message} ${err.detail}`).not.toContain(KEY);
  });

  it('times out and aborts the request', async () => {
    let signal: AbortSignal | undefined;
    const impl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const provider = createGroqProvider({ apiKey: KEY, model: MODEL, fetch: impl });
    const err = await failure(provider, request({ timeoutMs: 20 }));
    expect(err.code).toBe('TIMEOUT');
    expect(err.retryable).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  it('never puts the key, a gsk_ token or the Authorization header in a message or detail', async () => {
    const { provider } = setup(
      json({ error: { message: `Invalid key ${KEY} and gsk_otherSecretToken123` } }, 401),
    );
    const err = await failure(provider);
    const everything = `${err.message} ${err.detail ?? ''} ${JSON.stringify(err)}`;
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain('gsk_otherSecretToken123');
    expect(everything.toLowerCase()).not.toContain('bearer');
  });

  it('bounds the provider detail', async () => {
    const { provider } = setup(json({ error: { message: 'x'.repeat(5000) } }, 500));
    expect((await failure(provider)).detail!.length).toBeLessThanOrEqual(300);
  });
});

describe('Groq through the shared client', () => {
  const schema = z.object({ skill: z.string().min(1).max(50) });
  const args = { stage: 's', system: 'a', prompt: 'b', schema, maxOutputTokens: 100 };

  it('sends a strict schema, parses the reply and reports the provider id', async () => {
    const { provider, calls } = setup(json(completion()));
    const client = createLlmClient({ provider, maxRetries: 0 });
    expect(client.providerId).toBe('groq');
    expect(await client.generateObject(args)).toEqual({ skill: 'sql' });
    const sent = JSON.parse(String(calls[0]!.init.body)).response_format.json_schema.schema;
    expect(sent).toEqual({
      type: 'object',
      properties: { skill: { type: 'string' } },
      required: ['skill'],
      additionalProperties: false,
    });
  });

  it('repairs malformed JSON once, using one more request', async () => {
    const { provider, calls } = setup((n) =>
      json(
        n === 1
          ? completion({}, { message: { role: 'assistant', content: 'not json' } })
          : completion(),
      ),
    );
    const client = createLlmClient({ provider, maxRetries: 0 });
    await client.generateObject(args);
    expect(calls).toHaveLength(2);
    expect(client.stats.repairs).toBe(1);
  });

  it('retries a transient 503 through the shared client only', async () => {
    const { provider, calls } = setup((n) =>
      n === 1 ? json({ error: { message: 'busy' } }, 503) : json(completion()),
    );
    const client = createLlmClient({ provider, maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 });
    await client.generateObject(args);
    expect(calls).toHaveLength(2);
  });

  it('fails clearly, before any request, for a schema strict mode cannot express', async () => {
    const { provider, calls } = setup(json(completion()));
    const client = createLlmClient({ provider });
    const optional = z.object({ a: z.string(), b: z.string().optional() });
    await expect(client.generateObject({ ...args, schema: optional })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: expect.stringMatching(/optional field/),
    });
    expect(calls).toHaveLength(0);
  });
});
