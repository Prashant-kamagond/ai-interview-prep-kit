import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFakeClock } from '../research/test-support/fake-clock.js';
import { createLlmClient, type LlmClientOptions, type LlmEvent } from './client.js';
import { LlmError } from './errors.js';
import { createFakeProvider, type FakeScript } from './test-support/fake-provider.js';

const schema = z.object({ skill: z.string().min(1), years: z.number().int().min(0).max(60) });
const GOOD = { skill: 'React', years: 5 };

function setup(script: FakeScript, options: Partial<LlmClientOptions> = {}, providerOptions = {}) {
  const clock = createFakeClock(0);
  const provider = createFakeProvider(script, providerOptions);
  const events: LlmEvent[] = [];
  const client = createLlmClient({
    provider,
    clock,
    random: () => 1, // full backoff delay, so waits are exact
    onEvent: (e) => events.push(e),
    ...options,
  });
  const run = (over: Record<string, unknown> = {}) =>
    client.generateObject({
      stage: 'extract',
      system: 'SYSTEM',
      prompt: 'PROMPT',
      schema,
      maxOutputTokens: 500,
      ...over,
    });
  return { client, provider, clock, events, run };
}

async function failure(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(LlmError);
    return err as LlmError;
  }
  throw new Error('expected failure');
}

describe('success path', () => {
  it('returns the validated object and records usage', async () => {
    const { run, client, provider } = setup(() => GOOD);
    expect(await run()).toEqual(GOOD);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({
      system: 'SYSTEM',
      prompt: 'PROMPT',
      maxOutputTokens: 500,
    });
    expect(client.stats).toMatchObject({
      logicalCalls: 1,
      providerCalls: 1,
      retries: 0,
      repairs: 0,
      inputTokens: 100,
      outputTokens: 50,
      thoughtTokens: 10,
    });
    expect(client.stats.byStage.extract).toMatchObject({ providerCalls: 1 });
  });

  it('sends the Gemini-compatible JSON schema, built from the Zod schema', async () => {
    const { run, provider } = setup(() => GOOD);
    await run();
    const sent = provider.calls[0]!.schema as { type: string; required: string[] };
    expect(sent.type).toBe('object');
    expect(sent.required).toEqual(expect.arrayContaining(['skill', 'years']));
  });

  it('accepts JSON wrapped in a code fence or surrounded by prose', async () => {
    const fenced = setup(() => '```json\n{"skill":"React","years":5}\n```');
    expect(await fenced.run()).toEqual(GOOD);
    const prose = setup(() => 'Here you go: {"skill":"React","years":5} Hope it helps!');
    expect(await prose.run()).toEqual(GOOD);
  });

  it('reports the model it uses and never swaps it', async () => {
    const { client } = setup(() => GOOD, {}, { model: 'gemini-3.8-flash' });
    expect(client.model).toBe('gemini-3.8-flash');
    expect(client.providerId).toBe('fake');
  });
});

describe('bounded output', () => {
  it('caps the requested output tokens', async () => {
    const { run, provider } = setup(() => GOOD, { maxOutputTokensCap: 2000 });
    await run({ maxOutputTokens: 1_000_000 });
    expect(provider.calls[0]!.maxOutputTokens).toBe(2000);
  });
});

describe('retries', () => {
  it('retries transient failures with exponential backoff and then succeeds', async () => {
    const { run, clock, provider, client } = setup((_r, n) =>
      n < 4 ? new LlmError('PROVIDER_UNAVAILABLE') : GOOD,
    );
    expect(await run()).toEqual(GOOD);
    expect(provider.calls).toHaveLength(4);
    expect(clock.sleeps).toEqual([1000, 2000, 4000]);
    expect(client.stats).toMatchObject({ providerCalls: 4, retries: 3, logicalCalls: 1 });
  });

  it('honours Retry-After when it is longer than the backoff', async () => {
    const { run, clock } = setup((_r, n) =>
      n === 1 ? new LlmError('RATE_LIMITED', { retryAfterMs: 7000 }) : GOOD,
    );
    await run();
    expect(clock.sleeps).toEqual([7000]);
  });

  it('waits for a Retry-After that is within the limit', async () => {
    const { run, clock } = setup(
      (_r, n) => (n === 1 ? new LlmError('RATE_LIMITED', { retryAfterMs: 15_000 }) : GOOD),
      { maxRetryAfterMs: 20_000 },
    );
    await run();
    expect(clock.sleeps).toEqual([15_000]);
  });

  it('does not retry at all when the server asks for longer than it will wait', async () => {
    const { run, clock, provider } = setup(
      () => new LlmError('RATE_LIMITED', { retryAfterMs: 600_000 }),
      { maxRetryAfterMs: 20_000 },
    );
    const err = await failure(run());
    expect(err.code).toBe('RATE_LIMITED');
    expect(provider.calls).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('gives up after the retry budget: it never retries forever', async () => {
    const { run, provider } = setup(() => new LlmError('RATE_LIMITED'), { maxRetries: 3 });
    const err = await failure(run());
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.attempts).toBe(4);
    expect(provider.calls).toHaveLength(4);
  });

  it('retries a timeout, and a network error, but only within the budget', async () => {
    for (const code of ['TIMEOUT', 'NETWORK_ERROR'] as const) {
      const { run, provider } = setup(() => new LlmError(code), { maxRetries: 2 });
      expect((await failure(run())).code).toBe(code);
      expect(provider.calls).toHaveLength(3);
    }
  });

  it.each([
    'AUTH_FAILED',
    'INVALID_REQUEST',
    'MODEL_NOT_FOUND',
    'QUOTA_EXHAUSTED',
    'CONTENT_BLOCKED',
    'MISSING_CREDENTIALS',
  ] as const)('does not retry %s', async (code) => {
    const { run, provider, clock } = setup(() => new LlmError(code));
    expect((await failure(run())).code).toBe(code);
    expect(provider.calls).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('does not wrap unexpected (non-LLM) errors as provider failures', async () => {
    const { run, provider } = setup(() => new TypeError('bug'));
    await expect(run()).rejects.toThrow(TypeError);
    expect(provider.calls).toHaveLength(1);
  });
});

describe('exhausted quota', () => {
  it('fails every later call fast, without sending it, once the provider reports the quota gone', async () => {
    const { client, provider } = setup(() => new LlmError('QUOTA_EXHAUSTED'));
    const call = () =>
      client.generateObject({ stage: 's', system: 'a', prompt: 'b', schema, maxOutputTokens: 100 });
    expect((await failure(call())).code).toBe('QUOTA_EXHAUSTED');
    expect((await failure(call())).code).toBe('QUOTA_EXHAUSTED');
    expect((await failure(call())).code).toBe('QUOTA_EXHAUSTED');
    expect(provider.calls).toHaveLength(1);
  });

  it('does not treat an ordinary rate limit that way', async () => {
    const { client, provider } = setup((_r, n) => (n === 1 ? new LlmError('RATE_LIMITED') : GOOD), {
      maxRetries: 0,
    });
    const call = () =>
      client.generateObject({ stage: 's', system: 'a', prompt: 'b', schema, maxOutputTokens: 100 });
    await failure(call());
    expect(await call()).toEqual(GOOD);
    expect(provider.calls).toHaveLength(2);
  });
});

describe('validation and the bounded repair attempt', () => {
  it('repairs malformed JSON once, telling the model what was wrong', async () => {
    const { run, provider, client } = setup((_r, n) => (n === 1 ? '{"skill": "React", ' : GOOD));
    expect(await run()).toEqual(GOOD);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.prompt).toContain('PROMPT');
    expect(provider.calls[1]!.prompt).toMatch(/not valid JSON/i);
    expect(client.stats.repairs).toBe(1);
  });

  it('repairs a schema violation once, listing the offending fields but not inventing content', async () => {
    const { run, provider } = setup((_r, n) => (n === 1 ? { skill: '', years: 'five' } : GOOD));
    await run();
    const repair = provider.calls[1]!.prompt;
    expect(repair).toMatch(/skill/);
    expect(repair).toMatch(/years/);
  });

  it('repairs a semantic problem found by the stage, once', async () => {
    const { run, provider } = setup((_r, n) =>
      n === 1 ? { skill: 'React', years: 5 } : { skill: 'Node', years: 3 },
    );
    const result = await run({
      validate: (v: { skill: string }) => (v.skill === 'React' ? ['skill must not be React'] : []),
    });
    expect(result.skill).toBe('Node');
    expect(provider.calls[1]!.prompt).toContain('skill must not be React');
  });

  it('fails with INVALID_OUTPUT after exactly one repair: no unbounded loop', async () => {
    const { run, provider } = setup(() => '{"nope": true}');
    const err = await failure(run());
    expect(err.code).toBe('INVALID_OUTPUT');
    expect(err.issues?.length).toBeGreaterThan(0);
    expect(provider.calls).toHaveLength(2);
  });

  it('can be configured to allow no repair at all', async () => {
    const { run, provider } = setup(() => 'not json', { repairAttempts: 0 });
    expect((await failure(run())).code).toBe('INVALID_OUTPUT');
    expect(provider.calls).toHaveLength(1);
  });

  it('truncates the previous reply that it quotes back in a repair prompt', async () => {
    const huge = `{"skill": "${'x'.repeat(50_000)}"`;
    const { run, provider } = setup((_r, n) => (n === 1 ? huge : GOOD));
    await run();
    expect(provider.calls[1]!.prompt.length).toBeLessThan(5000);
  });

  it('repairs truncated output once, asking for a shorter reply', async () => {
    const { run, provider } = setup((_r, n) => (n === 1 ? new LlmError('OUTPUT_TRUNCATED') : GOOD));
    await run();
    expect(provider.calls[1]!.prompt).toMatch(/cut off|shorter/i);
  });

  it('fails if output is truncated again after the repair', async () => {
    const { run, provider } = setup(() => new LlmError('OUTPUT_TRUNCATED'));
    expect((await failure(run())).code).toBe('OUTPUT_TRUNCATED');
    expect(provider.calls).toHaveLength(2);
  });

  it('a repair attempt that hits a transient error still gets bounded retries', async () => {
    const { run, provider } = setup((_r, n) => {
      if (n === 1) return 'bad';
      if (n === 2) return new LlmError('RATE_LIMITED');
      return GOOD;
    });
    expect(await run()).toEqual(GOOD);
    expect(provider.calls).toHaveLength(3);
  });
});

describe('deadline', () => {
  it('refuses to start a call once the deadline has passed', async () => {
    const { run, provider } = setup(() => GOOD, { deadline: 0 });
    const err = await failure(run());
    expect(err.code).toBe('BUDGET_EXHAUSTED');
    expect(provider.calls).toHaveLength(0);
  });

  it('limits each attempt to the time that is left', async () => {
    const { run, provider } = setup(() => GOOD, { deadline: 5000, requestTimeoutMs: 60_000 });
    await run();
    expect(provider.calls[0]!.timeoutMs).toBe(5000);
  });

  it('uses the per-request timeout when it is shorter than the time left', async () => {
    const { run, provider } = setup(() => GOOD, { deadline: 600_000, requestTimeoutMs: 45_000 });
    await run();
    expect(provider.calls[0]!.timeoutMs).toBe(45_000);
  });

  it('does not begin a retry whose wait would pass the deadline', async () => {
    const { run, provider } = setup(() => new LlmError('RATE_LIMITED', { retryAfterMs: 30_000 }), {
      deadline: 10_000,
      maxRetryAfterMs: 60_000,
    });
    const err = await failure(run());
    expect(err.code).toBe('RATE_LIMITED');
    expect(provider.calls).toHaveLength(1);
  });
});

describe('concurrency and pacing', () => {
  it('never runs more calls at once than the configured limit', async () => {
    const { client, provider } = setup(() => GOOD, { maxConcurrency: 2 }, { latencyMs: 15 });
    await Promise.all(
      Array.from({ length: 8 }, () =>
        client.generateObject({
          stage: 's',
          system: 'a',
          prompt: 'b',
          schema,
          maxOutputTokens: 100,
        }),
      ),
    );
    expect(provider.calls).toHaveLength(8);
    expect(provider.maxInFlight).toBe(2);
  });

  it('runs strictly one at a time when asked to', async () => {
    const { client, provider } = setup(() => GOOD, { maxConcurrency: 1 }, { latencyMs: 5 });
    await Promise.all(
      Array.from({ length: 4 }, () =>
        client.generateObject({
          stage: 's',
          system: 'a',
          prompt: 'b',
          schema,
          maxOutputTokens: 100,
        }),
      ),
    );
    expect(provider.maxInFlight).toBe(1);
  });

  it('spaces the start of consecutive calls by the minimum interval', async () => {
    const starts: number[] = [];
    const clock = createFakeClock(0);
    const provider = createFakeProvider(() => {
      starts.push(clock.now());
      return GOOD;
    });
    const client = createLlmClient({
      provider,
      clock,
      maxConcurrency: 3,
      minIntervalMs: 1000,
      random: () => 1,
    });
    await Promise.all(
      [1, 2, 3].map(() =>
        client.generateObject({
          stage: 's',
          system: 'a',
          prompt: 'b',
          schema,
          maxOutputTokens: 100,
        }),
      ),
    );
    expect(starts).toEqual([0, 1000, 2000]);
  });
});

describe('observability without leaking', () => {
  it('emits attempt, retry and repair events with metadata only', async () => {
    const secretPrompt = 'SECRET JOB DESCRIPTION TEXT';
    const { run, events } = setup((_r, n) => {
      if (n === 1)
        return new LlmError('RATE_LIMITED', {
          detail: 'provider said: SECRET JOB DESCRIPTION TEXT',
        });
      if (n === 2) return 'broken json';
      return GOOD;
    });
    await run({ prompt: secretPrompt });
    const types = events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['attempt', 'retry', 'repair']));
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain('SECRET JOB DESCRIPTION');
    expect(serialised).not.toContain('broken json');
    const attempt = events.find((e) => e.type === 'attempt' && e.outcome === 'ok');
    expect(attempt).toMatchObject({
      stage: 'extract',
      inputTokens: 100,
      outputTokens: 50,
      thoughtTokens: 10,
    });
  });

  it('accumulates per-stage statistics', async () => {
    const { client } = setup(() => GOOD);
    for (const stage of ['a', 'a', 'b']) {
      await client.generateObject({
        stage,
        system: 's',
        prompt: 'p',
        schema,
        maxOutputTokens: 100,
      });
    }
    expect(client.stats.byStage.a!.providerCalls).toBe(2);
    expect(client.stats.byStage.b!.providerCalls).toBe(1);
    expect(client.stats.logicalCalls).toBe(3);
  });
});
