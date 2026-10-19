import type { z } from 'zod';
import { systemClock, type Clock } from '../research/clock.js';
import { withRetry } from '../research/retry.js';
import { LlmError } from './errors.js';
import { toGeminiSchema } from './json-schema.js';
import type { JsonSchema, LlmProvider, LlmResponse } from './types.js';

/**
 * Wraps a provider with everything every model call needs: bounded retries with exponential
 * backoff and jitter (honouring Retry-After), a per-attempt timeout, an overall deadline, limits on
 * concurrency and call spacing, usage accounting, and structured-output handling: parse, validate
 * with Zod and with the caller's own rules, and at most one bounded repair attempt.
 *
 * The model never decides anything here: it only produces JSON that application code accepts or
 * rejects.
 */

export type LlmEvent =
  | {
      type: 'attempt';
      stage: string;
      attempt: number;
      outcome: 'ok' | 'error';
      code?: string;
      durationMs: number;
      inputTokens?: number;
      outputTokens?: number;
      thoughtTokens?: number;
    }
  | { type: 'retry'; stage: string; attempt: number; delayMs: number; code: string }
  | {
      type: 'repair';
      stage: string;
      reason: 'parse' | 'schema' | 'semantic' | 'truncated';
      issues: number;
    };

export interface LlmStats {
  /** generateObject() invocations. */
  logicalCalls: number;
  /** Requests actually sent to the provider, including retries and repairs. */
  providerCalls: number;
  retries: number;
  repairs: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  /** Summed wall-clock time of provider requests (concurrent requests overlap). */
  totalMs: number;
  byStage: Record<string, { providerCalls: number; ms: number }>;
}

export interface LlmClientOptions {
  provider: LlmProvider;
  clock?: Clock;
  /** Time allowed for one attempt. Tail latency is real, so this is deliberately not huge. */
  requestTimeoutMs?: number;
  /** Retries after the first attempt, for transient failures only. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetryAfterMs?: number;
  maxConcurrency?: number;
  /** Minimum gap between the starts of two calls. */
  minIntervalMs?: number;
  /** Absolute time (clock scale) by which all calls must be finished. */
  deadline?: number;
  /** Hard ceiling on requested output tokens. */
  maxOutputTokensCap?: number;
  /** Extra attempts after invalid output. 0 disables repair. */
  repairAttempts?: number;
  random?: () => number;
  /** Receives metadata only: never prompts, replies, provider text or keys. */
  onEvent?: (event: LlmEvent) => void;
}

export interface GenerateObjectArgs<T> {
  /** A short label for statistics and events, e.g. "questions:technical". */
  stage: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxOutputTokens: number;
  /** Extra checks on the parsed value. Return problems (no content); empty means valid. */
  validate?: (value: T) => string[];
}

export interface LlmClient {
  generateObject<T>(args: GenerateObjectArgs<T>): Promise<T>;
  readonly stats: LlmStats;
  readonly model: string;
  readonly providerId: string;
}

const DEFAULTS = {
  requestTimeoutMs: 60_000,
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 60_000,
  maxConcurrency: 2,
  minIntervalMs: 0,
  maxOutputTokensCap: 16_384,
  repairAttempts: 1,
};

const MAX_ISSUES = 10;
const MAX_QUOTED_REPLY_CHARS = 1500;

class Limiter {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private lastStart: number | undefined;
  private gate: Promise<void> = Promise.resolve();

  constructor(
    private readonly max: number,
    private readonly minIntervalMs: number,
    private readonly clock: Clock,
  ) {}

  private async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    // The slot is handed over by release(), so `active` is already counted for us.
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      if (this.minIntervalMs > 0) {
        // Starts are paced one after another, even when several callers hold slots at once.
        this.gate = this.gate.then(async () => {
          if (this.lastStart !== undefined) {
            const wait = this.lastStart + this.minIntervalMs - this.clock.now();
            if (wait > 0) await this.clock.sleep(wait);
          }
          this.lastStart = this.clock.now();
        });
        await this.gate;
      }
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** Accepts a bare JSON object, one inside a code fence, or one surrounded by prose. */
function parseJsonLoose(text: string): { ok: true; value: unknown } | { ok: false } {
  const candidates: string[] = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // try the next shape
    }
  }
  return { ok: false };
}

function describeZodIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, MAX_ISSUES).map((issue) => {
    const path = issue.path.reduce<string>((out, part) => {
      if (typeof part === 'number') return `${out}[${part}]`;
      return out === '' ? String(part) : `${out}.${String(part)}`;
    }, '');
    return `${path || '(root)'}: ${issue.message}`;
  });
}

function repairPrompt(original: string, previous: string, problems: string[]): string {
  const quoted =
    previous.length > MAX_QUOTED_REPLY_CHARS
      ? `${previous.slice(0, MAX_QUOTED_REPLY_CHARS)} …`
      : previous;
  return [
    original,
    '',
    'Your previous reply was rejected for these reasons:',
    ...problems.slice(0, MAX_ISSUES).map((p) => `- ${p}`),
    '',
    'Your previous reply (possibly shortened):',
    quoted,
    '',
    'Reply again with ONE corrected JSON object that satisfies the schema. Do not explain.',
  ].join('\n');
}

function truncatedPrompt(original: string): string {
  return `${original}\n\nYour previous reply was cut off before it finished. Reply again with a shorter JSON object: fewer items and shorter text. Do not explain.`;
}

export function createLlmClient(options: LlmClientOptions): LlmClient {
  const { provider } = options;
  const clock = options.clock ?? systemClock;
  const cfg = {
    ...DEFAULTS,
    ...stripUndefined(options as unknown as Record<string, unknown>),
  } as typeof DEFAULTS;
  const limiter = new Limiter(cfg.maxConcurrency, cfg.minIntervalMs, clock);
  // Once the provider says the quota is gone, every further call would fail the same way. Remember
  // it and fail fast, instead of spending time and requests on calls that cannot succeed.
  let quotaExhausted = false;
  const schemaCache = new WeakMap<object, JsonSchema>();

  const stats: LlmStats = {
    logicalCalls: 0,
    providerCalls: 0,
    retries: 0,
    repairs: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    totalMs: 0,
    byStage: {},
  };

  const emit = (event: LlmEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // an observer must never break generation
    }
  };

  const stageStats = (stage: string) => (stats.byStage[stage] ??= { providerCalls: 0, ms: 0 });

  async function call(
    stage: string,
    system: string,
    prompt: string,
    schema: JsonSchema,
    maxOutputTokens: number,
  ): Promise<LlmResponse> {
    return withRetry(
      (attempt) =>
        limiter.run(async () => {
          if (quotaExhausted) throw new LlmError('QUOTA_EXHAUSTED');
          const now = clock.now();
          if (options.deadline !== undefined && now >= options.deadline)
            throw new LlmError('BUDGET_EXHAUSTED');
          const remaining =
            options.deadline === undefined ? Number.POSITIVE_INFINITY : options.deadline - now;

          stats.providerCalls++;
          stageStats(stage).providerCalls++;
          const started = clock.now();
          try {
            const response = await provider.generate({
              system,
              prompt,
              schema,
              maxOutputTokens: Math.min(maxOutputTokens, cfg.maxOutputTokensCap),
              timeoutMs: Math.min(cfg.requestTimeoutMs, remaining),
            });
            const durationMs = clock.now() - started;
            stats.totalMs += durationMs;
            stageStats(stage).ms += durationMs;
            stats.inputTokens += response.usage.inputTokens;
            stats.outputTokens += response.usage.outputTokens;
            stats.thoughtTokens += response.usage.thoughtTokens;
            emit({ type: 'attempt', stage, attempt, outcome: 'ok', durationMs, ...response.usage });
            return response;
          } catch (err) {
            const durationMs = clock.now() - started;
            stats.totalMs += durationMs;
            stageStats(stage).ms += durationMs;
            emit({
              type: 'attempt',
              stage,
              attempt,
              outcome: 'error',
              durationMs,
              ...(err instanceof LlmError ? { code: err.code } : {}),
            });
            if (err instanceof LlmError && err.code === 'QUOTA_EXHAUSTED') quotaExhausted = true;
            throw err;
          }
        }),
      {
        maxRetries: cfg.maxRetries,
        baseDelayMs: cfg.baseDelayMs,
        maxDelayMs: cfg.maxDelayMs,
        maxRetryAfterMs: cfg.maxRetryAfterMs,
        clock,
        ...(options.random ? { random: options.random } : {}),
        ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
        onRetry: ({ attempt, delayMs, error }) => {
          stats.retries++;
          emit({
            type: 'retry',
            stage,
            attempt,
            delayMs,
            code: error instanceof LlmError ? error.code : 'ERROR',
          });
        },
      },
    );
  }

  return {
    stats,
    model: provider.model,
    providerId: provider.id,

    async generateObject<T>(args: GenerateObjectArgs<T>): Promise<T> {
      stats.logicalCalls++;
      let jsonSchema = schemaCache.get(args.schema);
      if (!jsonSchema) {
        jsonSchema = toGeminiSchema(args.schema);
        schemaCache.set(args.schema, jsonSchema);
      }

      let prompt = args.prompt;
      try {
        for (let round = 0; ; round++) {
          const canRepair = round < cfg.repairAttempts;

          let response: LlmResponse;
          try {
            response = await call(
              args.stage,
              args.system,
              prompt,
              jsonSchema,
              args.maxOutputTokens,
            );
          } catch (err) {
            if (err instanceof LlmError && err.code === 'OUTPUT_TRUNCATED' && canRepair) {
              stats.repairs++;
              emit({ type: 'repair', stage: args.stage, reason: 'truncated', issues: 0 });
              prompt = truncatedPrompt(args.prompt);
              continue;
            }
            throw err;
          }

          let problems: string[];
          let reason: 'parse' | 'schema' | 'semantic';
          const parsed = parseJsonLoose(response.text);
          if (!parsed.ok) {
            problems = ['The reply was not valid JSON.'];
            reason = 'parse';
          } else {
            const checked = args.schema.safeParse(parsed.value);
            if (!checked.success) {
              problems = describeZodIssues(checked.error);
              reason = 'schema';
            } else {
              problems = args.validate?.(checked.data) ?? [];
              reason = 'semantic';
              if (problems.length === 0) return checked.data;
            }
          }

          if (!canRepair) {
            throw new LlmError('INVALID_OUTPUT', { issues: problems.slice(0, MAX_ISSUES) });
          }
          stats.repairs++;
          emit({ type: 'repair', stage: args.stage, reason, issues: problems.length });
          prompt = repairPrompt(args.prompt, response.text, problems);
        }
      } catch (err) {
        stats.failures++;
        throw err;
      }
    },
  };
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}
