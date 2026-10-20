import { z } from 'zod';
import { LlmError } from './errors.js';
import { GROQ_DEFAULT_MODEL, GROQ_STRICT_MODELS, isGroqStrictModel } from './groq.js';

export const DEFAULT_MODEL = 'gemini-3.8-flash';

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export interface LlmConfig {
  provider: LlmProviderId;
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

/** Accepted values of LLM_PROVIDER, lower case. */
export const LLM_PROVIDERS = ['gemini', 'groq'] as const;
export type LlmProviderId = (typeof LLM_PROVIDERS)[number];

const common = {
  LLM_THINKING_LEVEL: z.enum(['minimal', 'low', 'medium', 'high']).default('low'),
  LLM_REQUEST_TIMEOUT_MS: int(1000, 600_000).default(60_000),
  LLM_MAX_RETRIES: int(0, 6).default(3),
  LLM_MAX_CONCURRENCY: int(1, 8).default(2),
  LLM_MIN_INTERVAL_MS: int(0, 120_000).default(0),
};

const geminiSchema = z.object({
  LLM_MODEL: z
    .string()
    .trim()
    .regex(/^(models\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/)
    .default(DEFAULT_MODEL),
  ...common,
});

const groqSchema = z.object({
  // Groq model ids contain a slash (for example openai/gpt-oss-20b).
  LLM_MODEL: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
    .default(GROQ_DEFAULT_MODEL),
  ...common,
});

/** Where each provider's key lives. A provider only ever reads its own variable. */
const KEY_VARIABLE: Record<LlmProviderId, string> = {
  gemini: 'LLM_API_KEY',
  groq: 'GROQ_API_KEY',
};

/**
 * Reads the LLM settings from the environment. `LLM_PROVIDER` is `gemini` (the default) or `groq`, in lower
 * case. Gemini's key is `LLM_API_KEY`; Groq's is `GROQ_API_KEY`, and the other provider's key is never used.
 * A missing or malformed key is a clear configuration error (MISSING_CREDENTIALS) and nothing is called.
 * Error messages name the offending variables but never echo values, and the key is hidden from
 * serialisation.
 */
export function loadLlmConfig(env: Record<string, string | undefined> = process.env): LlmConfig {
  const requested = (env.LLM_PROVIDER ?? '').trim();
  const provider = (requested === '' ? 'gemini' : requested) as LlmProviderId;
  if (!LLM_PROVIDERS.includes(provider)) {
    throw new Error('Invalid LLM configuration: LLM_PROVIDER (use gemini or groq)');
  }

  const keyName = KEY_VARIABLE[provider];
  const key = (env[keyName] ?? '').trim();
  if (key === '') {
    throw new LlmError(
      'MISSING_CREDENTIALS',
      provider === 'groq'
        ? {
            message:
              'The Groq API key is not configured. Set GROQ_API_KEY (create a key in the Groq console; see the README).',
          }
        : {},
    );
  }
  // A key is a single token. Anything else could smuggle extra headers into a request.
  if (!/^[!-~]+$/.test(key)) {
    throw new LlmError('MISSING_CREDENTIALS', {
      message: `${keyName} is malformed (it must be a single token with no spaces or line breaks).`,
    });
  }

  // A blank value (for example `LLM_MODEL=` left in a copied .env) means "not set", not "invalid".
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const parsed = (provider === 'groq' ? groqSchema : geminiSchema).safeParse(present);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new Error(`Invalid LLM configuration: ${names.join(', ')}`);
  }
  const e = parsed.data;

  const model = provider === 'gemini' ? e.LLM_MODEL.replace(/^models\//, '') : e.LLM_MODEL;
  // Groq's strict structured output is documented for a short list of models only. Anything else would have
  // to fall back to unconstrained JSON, which this application does not do silently.
  if (provider === 'groq' && !isGroqStrictModel(model)) {
    throw new Error(
      `Invalid LLM configuration: LLM_MODEL is not a Groq model with strict structured output (use one of: ${GROQ_STRICT_MODELS.join(', ')})`,
    );
  }

  const config = {
    provider,
    model,
    thinkingLevel: e.LLM_THINKING_LEVEL,
    requestTimeoutMs: e.LLM_REQUEST_TIMEOUT_MS,
    maxRetries: e.LLM_MAX_RETRIES,
    maxConcurrency: e.LLM_MAX_CONCURRENCY,
    minIntervalMs: e.LLM_MIN_INTERVAL_MS,
  } as LlmConfig;
  Object.defineProperty(config, 'apiKey', { value: key, enumerable: false });
  return config;
}
