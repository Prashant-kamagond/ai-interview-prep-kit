import { afterEach, describe, expect, it } from 'vitest';
import { LlmError, type LlmErrorCode } from './errors.js';
import { createGeminiProvider } from './gemini.js';
import type { LlmRequest } from './types.js';
import { startApiServer, type ApiReply, type ApiServer } from './test-support/api-server.js';

const KEY = 'test-key-0123456789-abcdefghijklmnop';
const servers: ApiServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const request = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  system: 'You extract data.',
  prompt: 'Extract the skill.',
  schema: { type: 'object', properties: { skill: { type: 'string' } }, required: ['skill'] },
  maxOutputTokens: 300,
  timeoutMs: 2000,
  ...over,
});

async function setup(
  reply: ApiReply | ((n: number) => ApiReply),
  options: Record<string, unknown> = {},
) {
  const server = await startApiServer((_call, n) =>
    typeof reply === 'function' ? reply(n) : reply,
  );
  servers.push(server);
  const provider = createGeminiProvider({
    apiKey: KEY,
    model: 'gemini-3.8-flash',
    baseUrl: server.baseUrl,
    ...options,
  });
  return { server, provider };
}

async function failure(
  provider: { generate(r: LlmRequest): Promise<unknown> },
  req = request(),
): Promise<LlmError> {
  try {
    await provider.generate(req);
  } catch (err) {
    expect(err).toBeInstanceOf(LlmError);
    return err as LlmError;
  }
  throw new Error('expected generate() to fail');
}

// Captured from a real call to /v1/interactions on 2026-10-19 (thought signature shortened).
const REAL_SUCCESS = {
  status: 'completed',
  usage: {
    total_tokens: 97,
    total_input_tokens: 31,
    input_tokens_by_modality: [{ modality: 'text', tokens: 31 }],
    total_cached_tokens: 0,
    total_output_tokens: 18,
    total_tool_use_tokens: 0,
    total_thought_tokens: 48,
  },
  created: '2026-10-19T10:22:10Z',
  updated: '2026-10-19T10:22:10Z',
  steps: [
    { signature: 'Eo4CCosCAWkUfRMR', type: 'thought' },
    {
      content: [{ text: '{\n  "skill": "React",\n  "years": 5\n}', type: 'text' }],
      type: 'model_output',
    },
  ],
  object: 'interaction',
  model: 'models/gemini-3.8-flash',
};

// Captured from real calls with an invalid key. The Interactions endpoints wrap the error in an array.
const REAL_INVALID_KEY = {
  error: {
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    status: 'INVALID_ARGUMENT',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'API_KEY_INVALID',
        domain: 'googleapis.com',
        metadata: { service: 'generativelanguage.googleapis.com' },
      },
    ],
  },
};

describe('request', () => {
  it('posts the documented Interactions v1 body, with the key in a header only', async () => {
    const { provider, server } = await setup({ body: REAL_SUCCESS });
    await provider.generate(request());

    const call = server.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/v1/interactions');
    expect(call.headers['x-goog-api-key']).toBe(KEY);
    expect(call.headers['content-type']).toContain('application/json');
    expect(call.path).not.toContain(KEY);
    expect(call.body).not.toContain(KEY);

    expect(JSON.parse(call.body)).toEqual({
      model: 'models/gemini-3.8-flash',
      input: 'Extract the skill.',
      system_instruction: 'You extract data.',
      generation_config: { max_output_tokens: 300, thinking_level: 'low' },
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: request().schema,
      },
      store: false,
    });
  });

  it('does not double the models/ prefix and honours the thinking level', async () => {
    const { provider, server } = await setup(
      { body: REAL_SUCCESS },
      { model: 'models/gemini-3.8-flash', thinkingLevel: 'medium' },
    );
    await provider.generate(request());
    const body = JSON.parse(server.calls[0]!.body);
    expect(body.model).toBe('models/gemini-3.8-flash');
    expect(body.generation_config.thinking_level).toBe('medium');
  });

  it('uses the configured API version path', async () => {
    const { provider, server } = await setup({ body: REAL_SUCCESS }, { apiVersion: 'v1beta' });
    await provider.generate(request());
    expect(server.calls[0]!.path).toBe('/v1beta/interactions');
  });

  it('reports the model it was configured with', async () => {
    const { provider } = await setup({ body: REAL_SUCCESS });
    expect(provider).toMatchObject({ id: 'gemini', model: 'gemini-3.8-flash' });
  });
});

describe('success', () => {
  it('extracts the model text and usage from the verified response shape', async () => {
    const { provider } = await setup({ body: REAL_SUCCESS });
    const res = await provider.generate(request());
    expect(JSON.parse(res.text)).toEqual({ skill: 'React', years: 5 });
    expect(res.usage).toEqual({ inputTokens: 31, outputTokens: 18, thoughtTokens: 48 });
    expect(res.model).toBe('models/gemini-3.8-flash');
  });

  it('joins multiple text parts and ignores thought steps', async () => {
    const { provider } = await setup({
      body: {
        ...REAL_SUCCESS,
        steps: [
          { type: 'thought', signature: 'x' },
          {
            type: 'model_output',
            content: [
              { type: 'text', text: '{"a":' },
              { type: 'text', text: '1}' },
            ],
          },
        ],
      },
    });
    expect((await provider.generate(request())).text).toBe('{"a":1}');
  });

  it('tolerates a missing usage block', async () => {
    const { provider } = await setup({ body: { ...REAL_SUCCESS, usage: undefined } });
    expect((await provider.generate(request())).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      thoughtTokens: 0,
    });
  });

  it('accepts a response wrapped in an array, as the endpoint sometimes does for errors', async () => {
    const { provider } = await setup({ body: [REAL_SUCCESS] });
    expect(JSON.parse((await provider.generate(request())).text).skill).toBe('React');
  });
});

describe('unusable successful responses', () => {
  it('reports status "incomplete" as truncated output', async () => {
    const { provider } = await setup({ body: { ...REAL_SUCCESS, status: 'incomplete' } });
    const err = await failure(provider);
    expect(err.code).toBe('OUTPUT_TRUNCATED');
    expect(err.retryable).toBe(false);
  });

  it('reports a response with no text as invalid output', async () => {
    const { provider } = await setup({
      body: { ...REAL_SUCCESS, steps: [{ type: 'thought', signature: 'x' }] },
    });
    expect((await failure(provider)).code).toBe('INVALID_OUTPUT');
  });

  it('reports a failed interaction, mapping safety codes to CONTENT_BLOCKED', async () => {
    const blocked = await setup({
      body: { status: 'failed', errors: [{ code: 'safety', message: 'blocked' }], steps: [] },
    });
    expect((await failure(blocked.provider)).code).toBe('CONTENT_BLOCKED');
    const other = await setup({
      body: { status: 'failed', errors: [{ code: 'api_error', message: 'x' }], steps: [] },
    });
    const err = await failure(other.provider);
    expect(err.code).toBe('PROVIDER_UNAVAILABLE');
    expect(err.retryable).toBe(true);
  });

  it('treats a non-final status as unavailable', async () => {
    const { provider } = await setup({ body: { ...REAL_SUCCESS, status: 'in_progress' } });
    expect((await failure(provider)).code).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('HTTP errors', () => {
  const cases: [string, ApiReply, LlmErrorCode, boolean][] = [
    [
      'an invalid key (HTTP 400, API_KEY_INVALID) as seen in practice',
      { status: 400, body: REAL_INVALID_KEY },
      'AUTH_FAILED',
      false,
    ],
    [
      'the same error wrapped in an array',
      { status: 400, body: [REAL_INVALID_KEY] },
      'AUTH_FAILED',
      false,
    ],
    [
      'HTTP 401',
      { status: 401, body: { error: { code: 401, status: 'UNAUTHENTICATED', message: 'no' } } },
      'AUTH_FAILED',
      false,
    ],
    [
      'HTTP 403',
      { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'no' } } },
      'AUTH_FAILED',
      false,
    ],
    [
      'another 400 as an invalid request',
      {
        status: 400,
        body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'bad schema' } },
      },
      'INVALID_REQUEST',
      false,
    ],
    [
      'HTTP 402',
      { status: 402, body: { error: { code: 402, message: 'credits' } } },
      'QUOTA_EXHAUSTED',
      false,
    ],
    [
      'HTTP 404',
      { status: 404, body: { error: { code: 404, status: 'NOT_FOUND', message: 'model' } } },
      'MODEL_NOT_FOUND',
      false,
    ],
    [
      'HTTP 429',
      {
        status: 429,
        body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'slow' } },
      },
      'RATE_LIMITED',
      true,
    ],
    [
      'HTTP 500',
      { status: 500, body: { error: { code: 500, message: 'oops' } } },
      'PROVIDER_UNAVAILABLE',
      true,
    ],
    [
      'HTTP 502',
      { status: 502, body: 'Bad gateway', headers: { 'content-type': 'text/html' } },
      'PROVIDER_UNAVAILABLE',
      true,
    ],
    [
      'HTTP 503',
      { status: 503, body: { error: { code: 503, status: 'UNAVAILABLE', message: 'busy' } } },
      'PROVIDER_UNAVAILABLE',
      true,
    ],
    ['HTTP 504', { status: 504, body: '' }, 'PROVIDER_UNAVAILABLE', true],
  ];

  it.each(cases)('maps %s', async (_name, reply, code, retryable) => {
    const { provider } = await setup(reply);
    const err = await failure(provider);
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
  });

  it('reads Retry-After in seconds from a 429', async () => {
    const { provider } = await setup({
      status: 429,
      headers: { 'retry-after': '7' },
      body: { error: { code: 429 } },
    });
    expect((await failure(provider)).retryAfterMs).toBe(7000);
  });

  it('reads a RetryInfo delay from the error details', async () => {
    const { provider } = await setup({
      status: 429,
      body: {
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'rate',
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '34s' }],
        },
      },
    });
    expect((await failure(provider)).retryAfterMs).toBe(34_000);
  });

  it('treats a per-day quota as exhausted, not as a rate limit worth retrying', async () => {
    const { provider } = await setup({
      status: 429,
      body: {
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'quota',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [
                {
                  quotaMetric: 'generate_content_free_tier_requests',
                  quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
                },
              ],
            },
          ],
        },
      },
    });
    const err = await failure(provider);
    expect(err.code).toBe('QUOTA_EXHAUSTED');
    expect(err.retryable).toBe(false);
  });

  it('treats the real free-tier daily-limit 429 as an exhausted quota, not as a retryable rate limit', async () => {
    // Captured from a real call on 2026-10-19: a string code, no QuotaFailure details, a huge Retry-After.
    const { provider } = await setup({
      status: 429,
      headers: { 'retry-after': '71869' },
      body: {
        error: {
          message:
            'Rate limit exceeded for model gemini-3.8-flash (limit: 20 requests per day on Free Tier). Please retry in 19h57m49s or upgrade your tier at https://ai.dev/rate-limit.',
          code: 'too_many_requests',
        },
      },
    });
    const err = await failure(provider);
    expect(err.code).toBe('QUOTA_EXHAUSTED');
    expect(err.retryable).toBe(false);
    expect(err.retryAfterMs).toBe(71_869_000);
    expect(err.message).not.toMatch(/20 requests|19h/); // provider wording stays in the log-only detail
  });

  it('recognises a daily limit from its wording alone, with no Retry-After at all', async () => {
    const { provider } = await setup({
      status: 429,
      body: {
        error: {
          message: 'Rate limit exceeded for model x (limit: 20 requests per day on Free Tier).',
          code: 'too_many_requests',
        },
      },
    });
    const err = await failure(provider);
    expect(err.code).toBe('QUOTA_EXHAUSTED');
    expect(err.retryable).toBe(false);
  });

  it('treats a 429 whose Retry-After is many minutes away as a quota even without wording', async () => {
    const { provider } = await setup({
      status: 429,
      headers: { 'retry-after': '7200' },
      body: { error: { code: 429 } },
    });
    const err = await failure(provider);
    expect(err.code).toBe('QUOTA_EXHAUSTED');
    expect(err.retryAfterMs).toBe(7_200_000);
  });

  it('still treats a short per-minute 429 as a retryable rate limit', async () => {
    const { provider } = await setup({
      status: 429,
      headers: { 'retry-after': '30' },
      body: {
        error: {
          message: 'Rate limit exceeded (limit: 5 requests per minute). Please retry in 30s.',
          code: 'too_many_requests',
        },
      },
    });
    const err = await failure(provider);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(30_000);
  });

  it('reports an unparsable 2xx body as unavailable', async () => {
    const { provider } = await setup({ body: 'definitely not json' });
    expect((await failure(provider)).code).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('transport failures', () => {
  it('times out when the provider never answers, and says it is retryable', async () => {
    const { provider } = await setup({ hang: true });
    const err = await failure(provider, request({ timeoutMs: 150 }));
    expect(err.code).toBe('TIMEOUT');
    expect(err.retryable).toBe(true);
  });

  it('times out when the body stalls after the headers', async () => {
    const { provider } = await setup({ body: REAL_SUCCESS, delayMs: 600 });
    expect((await failure(provider, request({ timeoutMs: 150 }))).code).toBe('TIMEOUT');
  });

  it('reports an unreachable provider as a retryable network error', async () => {
    const server = await startApiServer(() => ({}));
    const baseUrl = server.baseUrl;
    await server.close();
    const provider = createGeminiProvider({ apiKey: KEY, model: 'gemini-3.8-flash', baseUrl });
    const err = await failure(provider);
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.retryable).toBe(true);
  });
});

describe('secrets and safe messages', () => {
  it('never lets the key into an error, even when the provider echoes it back', async () => {
    const { provider } = await setup({
      status: 400,
      body: {
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: `bad request for key ${KEY} here`,
        },
      },
    });
    const err = await failure(provider);
    const everything = JSON.stringify({
      m: err.message,
      d: err.detail,
      s: err.stack,
      c: String(err.cause),
    });
    expect(everything).not.toContain(KEY);
    expect(err.detail).toContain('[redacted]');
  });

  it('bounds the provider detail kept for server logs', async () => {
    const { provider } = await setup({
      status: 400,
      body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'x'.repeat(5000) } },
    });
    expect((await failure(provider)).detail!.length).toBeLessThanOrEqual(300);
  });

  it('keeps provider text out of the user-facing message', async () => {
    const { provider } = await setup({
      status: 400,
      body: {
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: 'echo of the prompt: SECRET JOB DESCRIPTION',
        },
      },
    });
    const err = await failure(provider);
    expect(err.message).not.toContain('SECRET JOB DESCRIPTION');
  });

  it('names the configured model when it is not found', async () => {
    const { provider } = await setup({
      status: 404,
      body: { error: { code: 404, status: 'NOT_FOUND', message: 'm' } },
    });
    expect((await failure(provider)).message).toContain('gemini-3.8-flash');
  });
});
