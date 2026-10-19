import type { ThinkingLevel } from './config.js';
import { LlmError } from './errors.js';
import type { LlmProvider, LlmRequest, LlmResponse } from './types.js';

/**
 * Google Gemini through the Interactions API (`POST {base}/v1/interactions`).
 *
 * Contract, from Google's documentation (checked 2026-10-19) and one live call (2026-10-19):
 *  - request: `model` ("models/<id>"), `input`, `system_instruction`,
 *    `generation_config { max_output_tokens, thinking_level }`,
 *    `response_format { type: "text", mime_type: "application/json", schema }`, `store: false`
 *  - success: `status: "completed"` and the JSON text in the `model_output` step's
 *    `content[].text`; `thought` steps carry opaque signatures and are ignored
 *  - usage: `total_input_tokens`, `total_output_tokens`, `total_thought_tokens`
 *  - an invalid key answers HTTP 400 (INVALID_ARGUMENT, reason API_KEY_INVALID), not 401, and the
 *    Interactions endpoints sometimes wrap error bodies in a JSON array
 *
 * The key travels only in the `x-goog-api-key` header: never in the URL, never in the body, and
 * never in an error message. `store: false` asks Google not to retain the interaction.
 */

export interface GeminiOptions {
  apiKey: string;
  /** Model id, with or without the "models/" prefix. */
  model: string;
  thinkingLevel?: ThinkingLevel;
  baseUrl?: string;
  apiVersion?: string;
  /** Test seam. Defaults to the platform fetch. */
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const MAX_DETAIL_CHARS = 300;
/** A 429 that asks for a wait this long is a quota, not rate smoothing. */
const QUOTA_WAIT_MS = 15 * 60_000;
const DAILY_WORDING = /\b(per day|per-day|daily)\b/i;
const SAFETY_CODES = new Set([
  'safety',
  'recitation',
  'language',
  'prohibited_content',
  'spii',
  'blocklist',
  'content_blocked',
]);

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function redact(text: string, secret: string): string {
  return text.split(secret).join('[redacted]');
}

function parseBody(text: string): Json | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const first = Array.isArray(value) ? value[0] : value; // errors are sometimes array-wrapped
  return isObject(first) ? first : null;
}

function retryAfterFromHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function detailsOf(error: Json): Json[] {
  return Array.isArray(error.details) ? error.details.filter(isObject) : [];
}

function retryDelayFromDetails(error: Json): number | undefined {
  for (const d of detailsOf(error)) {
    if (
      typeof d['@type'] === 'string' &&
      d['@type'].endsWith('RetryInfo') &&
      typeof d.retryDelay === 'string'
    ) {
      const seconds = Number.parseFloat(d.retryDelay);
      if (Number.isFinite(seconds)) return Math.round(seconds * 1000);
    }
  }
  return undefined;
}

function isDailyQuota(error: Json): boolean {
  for (const d of detailsOf(error)) {
    if (
      typeof d['@type'] === 'string' &&
      d['@type'].endsWith('QuotaFailure') &&
      Array.isArray(d.violations)
    ) {
      for (const v of d.violations) {
        if (isObject(v) && typeof v.quotaId === 'string' && /PerDay/i.test(v.quotaId)) return true;
      }
    }
  }
  return error.code === 'quota_exceeded';
}

function reasonOf(error: Json): string | undefined {
  for (const d of detailsOf(error)) if (typeof d.reason === 'string') return d.reason;
  return undefined;
}

export function createGeminiProvider(options: GeminiOptions): LlmProvider {
  const model = options.model.replace(/^models\//, '');
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const apiVersion = options.apiVersion ?? 'v1';
  const thinkingLevel = options.thinkingLevel ?? 'low';
  const doFetch = options.fetch ?? fetch;

  const safeDetail = (text: unknown): string | undefined =>
    typeof text === 'string' ? redact(text, options.apiKey).slice(0, MAX_DETAIL_CHARS) : undefined;

  function mapHttpError(status: number, error: Json, retryAfterHeader: string | null): LlmError {
    const detail = safeDetail(error.message);
    const retryAfterMs = retryAfterFromHeader(retryAfterHeader) ?? retryDelayFromDetails(error);
    const reason = reasonOf(error);
    const base = { status, ...(detail === undefined ? {} : { detail }) };

    // Observed: a bad key is HTTP 400 with reason API_KEY_INVALID, so the reason is checked first.
    if (
      reason === 'API_KEY_INVALID' ||
      reason === 'API_KEY_EXPIRED' ||
      status === 401 ||
      status === 403
    ) {
      return new LlmError('AUTH_FAILED', base);
    }
    if (status === 402) return new LlmError('QUOTA_EXHAUSTED', base);
    if (status === 404) return new LlmError('MODEL_NOT_FOUND', { ...base, model });
    if (status === 429) {
      // Observed live: the free-tier daily limit arrives as a plain 429 with a string code, no
      // QuotaFailure details, wording like "20 requests per day" and a Retry-After of many hours.
      // Retrying within this run cannot help, so it is a quota, not a rate limit.
      const message = typeof error.message === 'string' ? error.message : '';
      const quota =
        isDailyQuota(error) ||
        DAILY_WORDING.test(message) ||
        (retryAfterMs !== undefined && retryAfterMs > QUOTA_WAIT_MS);
      return quota
        ? new LlmError('QUOTA_EXHAUSTED', { ...base, retryAfterMs })
        : new LlmError('RATE_LIMITED', { ...base, retryAfterMs });
    }
    if (status === 400 || status === 416 || status === 422)
      return new LlmError('INVALID_REQUEST', base);
    return new LlmError('PROVIDER_UNAVAILABLE', { ...base, retryAfterMs });
  }

  function parseSuccess(body: Json): LlmResponse {
    const status = body.status;
    if (status === 'incomplete') return fail(new LlmError('OUTPUT_TRUNCATED'));
    if (status === 'failed' || status === 'cancelled') {
      const first = Array.isArray(body.errors) ? body.errors.find(isObject) : undefined;
      const code = typeof first?.code === 'string' ? first.code : '';
      const detail = safeDetail(first?.message);
      return fail(
        SAFETY_CODES.has(code)
          ? new LlmError('CONTENT_BLOCKED', detail === undefined ? {} : { detail })
          : new LlmError('PROVIDER_UNAVAILABLE', detail === undefined ? {} : { detail }),
      );
    }
    if (status !== 'completed') return fail(new LlmError('PROVIDER_UNAVAILABLE'));

    const steps = Array.isArray(body.steps) ? body.steps.filter(isObject) : [];
    const text = steps
      .filter((s) => s.type === 'model_output')
      .flatMap((s) => (Array.isArray(s.content) ? s.content.filter(isObject) : []))
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('');
    if (text.trim() === '')
      return fail(new LlmError('INVALID_OUTPUT', { message: 'The model returned no text.' }));

    const usage = isObject(body.usage) ? body.usage : {};
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
      text,
      model: typeof body.model === 'string' ? body.model : `models/${model}`,
      usage: {
        inputTokens: n(usage.total_input_tokens),
        outputTokens: n(usage.total_output_tokens),
        thoughtTokens: n(usage.total_thought_tokens),
      },
    };
  }

  const fail = (err: LlmError): never => {
    throw err;
  };

  return {
    id: 'gemini',
    model,

    async generate(req: LlmRequest): Promise<LlmResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs);
      try {
        let res: Response;
        let text: string;
        try {
          res = await doFetch(`${baseUrl}/${apiVersion}/interactions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
            body: JSON.stringify({
              model: `models/${model}`,
              input: req.prompt,
              system_instruction: req.system,
              generation_config: {
                max_output_tokens: req.maxOutputTokens,
                thinking_level: thinkingLevel,
              },
              response_format: { type: 'text', mime_type: 'application/json', schema: req.schema },
              store: false,
            }),
            signal: controller.signal,
          });
          text = await res.text();
        } catch (err) {
          if (controller.signal.aborted) throw new LlmError('TIMEOUT');
          // The underlying message can name hosts and sockets; keep only a bounded, redacted detail.
          throw new LlmError('NETWORK_ERROR', {
            ...(err instanceof Error && safeDetail(err.message)
              ? { detail: safeDetail(err.message)! }
              : {}),
          });
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
