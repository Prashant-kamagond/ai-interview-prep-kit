import type { z } from 'zod';
import type { ThinkingLevel } from './config.js';
import { LlmError } from './errors.js';
import { toGroqStrictSchema } from './groq-schema.js';
import type { JsonSchema, LlmProvider, LlmRequest, LlmResponse } from './types.js';

/**
 * Groq through its OpenAI-compatible Chat Completions API (`POST {base}/openai/v1/chat/completions`).
 *
 * Contract, from Groq's documentation (checked 2026-10-20; nothing here was exercised against the live API):
 *  - auth: `Authorization: Bearer <key>`
 *  - request: `model`, `messages` (system, user), `max_completion_tokens`, `reasoning_effort`,
 *    `response_format { type: "json_schema", json_schema { name, strict: true, schema } }`
 *  - strict structured output is documented only for the models in GROQ_STRICT_MODELS. Other Groq models
 *    offer JSON object mode, which does not enforce a schema, so they are refused rather than downgraded.
 *  - success: `choices[0].message.content` holds the JSON text, `finish_reason` is "stop" when complete;
 *    usage is `prompt_tokens` / `completion_tokens`
 *  - errors: `{ error: { message, type } }` with the status codes on the "Error Codes" page; `retry-after`
 *    (seconds) is set on a 429
 *
 * The key travels only in the Authorization header: never in the URL, the body, or an error message.
 * Retries belong to the shared client; this provider makes exactly one request per call.
 */

export const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-20b';

/** Models documented to support `strict: true` json_schema. */
export const GROQ_STRICT_MODELS: readonly string[] = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
  'meta-models/muse-spark-open',
];

export function isGroqStrictModel(model: string): boolean {
  return GROQ_STRICT_MODELS.includes(model);
}

export interface GroqOptions {
  apiKey: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  baseUrl?: string;
  /** Test seam. Defaults to the platform fetch. */
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.groq.com';
const MAX_DETAIL_CHARS = 300;
/** A 429 that asks for a wait this long is a quota, not rate smoothing. */
const QUOTA_WAIT_MS = 15 * 60_000;
const DAILY_WORDING = /\b(per day|per-day|daily|TPD|RPD)\b/i;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseBody(text: string): Json | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function retryAfterFromHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** The reasoning effort Groq accepts for a model (the documented values differ per model). */
function reasoningEffort(model: string, level: ThinkingLevel): string {
  if (model.startsWith('qwen/')) return level === 'minimal' ? 'none' : level;
  // gpt-oss and Muse Spark Open have no "minimal"; low is the closest.
  return level === 'minimal' ? 'low' : level;
}

export function createGroqProvider(options: GroqOptions): LlmProvider {
  const model = options.model;
  if (!isGroqStrictModel(model)) {
    throw new LlmError('INVALID_REQUEST', {
      message: `The configured Groq model does not support strict structured output. Set LLM_MODEL to one of: ${GROQ_STRICT_MODELS.join(', ')}.`,
    });
  }
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const thinkingLevel = options.thinkingLevel ?? 'low';
  const doFetch = options.fetch ?? fetch;

  const safeDetail = (text: unknown): string | undefined =>
    typeof text === 'string'
      ? text
          .split(options.apiKey)
          .join('[redacted]')
          .replace(/gsk_[A-Za-z0-9]+/g, '[redacted]')
          .slice(0, MAX_DETAIL_CHARS)
      : undefined;

  function mapHttpError(status: number, error: Json, retryAfterHeader: string | null): LlmError {
    const detail = safeDetail(error.message);
    const retryAfterMs = retryAfterFromHeader(retryAfterHeader);
    const base = { status, ...(detail === undefined ? {} : { detail }) };
    const code = typeof error.code === 'string' ? error.code : '';

    // The shared wording names Gemini's variable and console, so Groq supplies its own.
    const authMessage = 'The LLM provider rejected the API key. Check GROQ_API_KEY.';
    const quotaMessage =
      'The LLM provider quota is exhausted. Check your usage limits in the Groq console.';
    if (status === 401 || status === 403 || code === 'invalid_api_key')
      return new LlmError('AUTH_FAILED', { ...base, message: authMessage });
    if (status === 402) return new LlmError('QUOTA_EXHAUSTED', { ...base, message: quotaMessage });
    if (status === 404 || code === 'model_not_found' || code === 'model_decommissioned')
      return new LlmError('MODEL_NOT_FOUND', { ...base, model });
    if (status === 429) {
      const message = typeof error.message === 'string' ? error.message : '';
      const quota =
        DAILY_WORDING.test(message) || (retryAfterMs !== undefined && retryAfterMs > QUOTA_WAIT_MS);
      return quota
        ? new LlmError('QUOTA_EXHAUSTED', { ...base, retryAfterMs, message: quotaMessage })
        : new LlmError('RATE_LIMITED', { ...base, retryAfterMs });
    }
    // Groq answers 400 when the model's JSON did not match the schema. That is the model's output failing, not
    // a malformed request, so it is not fatal for the run.
    if (code === 'json_validate_failed') return new LlmError('INVALID_OUTPUT', base);
    if (status === 400 || status === 413 || status === 422)
      return new LlmError('INVALID_REQUEST', base);
    // 498 (flex capacity), 424, 5xx and anything unexpected: the provider side, worth a retry.
    return new LlmError('PROVIDER_UNAVAILABLE', { ...base, retryAfterMs });
  }

  function parseSuccess(body: Json): LlmResponse {
    const choice = Array.isArray(body.choices) ? body.choices.find(isObject) : undefined;
    if (!choice)
      throw new LlmError('INVALID_OUTPUT', { message: 'The model returned no choices.' });

    const message = isObject(choice.message) ? choice.message : {};
    const finish = choice.finish_reason;
    if (finish === 'length') throw new LlmError('OUTPUT_TRUNCATED');
    if (finish === 'content_filter') throw new LlmError('CONTENT_BLOCKED');
    if (typeof message.refusal === 'string' && message.refusal.trim() !== '')
      throw new LlmError('CONTENT_BLOCKED');
    if (typeof finish === 'string' && finish !== 'stop')
      throw new LlmError('INVALID_OUTPUT', { message: 'The model stopped before finishing.' });

    const text = typeof message.content === 'string' ? message.content : '';
    if (text.trim() === '')
      throw new LlmError('INVALID_OUTPUT', { message: 'The model returned no text.' });

    const usage = isObject(body.usage) ? body.usage : {};
    const details = isObject(usage.completion_tokens_details)
      ? usage.completion_tokens_details
      : {};
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    return {
      text,
      model: typeof body.model === 'string' ? body.model : model,
      usage: {
        inputTokens: n(usage.prompt_tokens),
        outputTokens: n(usage.completion_tokens),
        // Not documented for this API; reported only if Groq sends it, otherwise 0 (as for any missing count).
        thoughtTokens: n(details.reasoning_tokens),
      },
    };
  }

  return {
    id: 'groq',
    model,

    schemaFor(schema: z.ZodType): JsonSchema {
      return toGroqStrictSchema(schema);
    },

    async generate(req: LlmRequest): Promise<LlmResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs);
      try {
        let res: Response;
        let text: string;
        try {
          res = await doFetch(`${baseUrl}/openai/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${options.apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: req.system },
                { role: 'user', content: req.prompt },
              ],
              max_completion_tokens: req.maxOutputTokens,
              reasoning_effort: reasoningEffort(model, thinkingLevel),
              // gpt-oss returns its reasoning text by default; it is never used, so do not ask for it.
              ...(model.startsWith('openai/') ? { include_reasoning: false } : {}),
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'response', strict: true, schema: req.schema },
              },
            }),
            signal: controller.signal,
          });
          text = await res.text();
        } catch (err) {
          if (controller.signal.aborted) throw new LlmError('TIMEOUT');
          // The underlying message can name hosts and sockets; keep only a bounded, redacted detail.
          const detail = err instanceof Error ? safeDetail(err.message) : undefined;
          throw new LlmError('NETWORK_ERROR', detail ? { detail } : {});
        }

        const body = parseBody(text);
        if (!res.ok) {
          const error = body && isObject(body.error) ? body.error : {};
          throw mapHttpError(res.status, error, res.headers.get('retry-after'));
        }
        if (!body)
          throw new LlmError('PROVIDER_UNAVAILABLE', {
            message: 'The LLM provider returned an unreadable response.',
          });
        return parseSuccess(body);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
