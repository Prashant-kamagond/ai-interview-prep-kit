import { z } from 'zod';
import { LlmError } from './errors.js';

export const DEFAULT_MODEL = 'gemini-3.8-flash';

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export interface LlmConfig {
  provider: 'gemini';
  model: string;
  /** Present on the object but not enumerable, so JSON, logs and inspection never show it. */
  readonly apiKey: string;
  thinkingLevel: ThinkingLevel;
  requestTimeoutMs: number;
  maxRetries: number;
  maxConcurrency: number;
  minIntervalMs: number;
}

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const schema = z.object({
  LLM_PROVIDER: z.literal('gemini').default('gemini'),
  LLM_MODEL: z
    .string()
    .trim()
    .regex(/^(models\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/)
    .default(DEFAULT_MODEL),
  LLM_THINKING_LEVEL: z.enum(['minimal', 'low', 'medium', 'high']).default('low'),
  LLM_REQUEST_TIMEOUT_MS: int(1000, 600_000).default(60_000),
  LLM_MAX_RETRIES: int(0, 6).default(3),
  LLM_MAX_CONCURRENCY: int(1, 8).default(2),
  LLM_MIN_INTERVAL_MS: int(0, 120_000).default(0),
});

/**
 * Reads the LLM settings from the environment. A missing or malformed key is a clear
 * configuration error (MISSING_CREDENTIALS) and nothing is called. Error messages name the
 * offending variables but never echo values, and the key is hidden from serialisation.
 */
export function loadLlmConfig(env: Record<string, string | undefined> = process.env): LlmConfig {
  const key = (env.LLM_API_KEY ?? '').trim();
  if (key === '') throw new LlmError('MISSING_CREDENTIALS');
  // A key is a single token. Anything else could smuggle extra headers into a request.
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw new LlmError('MISSING_CREDENTIALS', {
      message:
        'LLM_API_KEY is malformed (it must be a single token with no spaces or line breaks).',
    });
  }

  // A blank value (for example `LLM_MODEL=` left in a copied .env) means "not set", not "invalid".
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new Error(`Invalid LLM configuration: ${names.join(', ')}`);
  }
  const e = parsed.data;

  const config = {
    provider: e.LLM_PROVIDER,
    model: e.LLM_MODEL.replace(/^models\//, ''),
    thinkingLevel: e.LLM_THINKING_LEVEL,
    requestTimeoutMs: e.LLM_REQUEST_TIMEOUT_MS,
    maxRetries: e.LLM_MAX_RETRIES,
    maxConcurrency: e.LLM_MAX_CONCURRENCY,
    minIntervalMs: e.LLM_MIN_INTERVAL_MS,
  } as LlmConfig;
  Object.defineProperty(config, 'apiKey', { value: key, enumerable: false });
  return config;
}
