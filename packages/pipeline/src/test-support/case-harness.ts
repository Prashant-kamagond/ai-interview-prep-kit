import { createLlmClient } from '../llm/client.js';
import {
  createFakeProvider,
  type FakeProvider,
  type FakeReply,
} from '../llm/test-support/fake-provider.js';
import type { LlmRequest } from '../llm/types.js';
import type { Clock } from '../research/clock.js';
import type { DiscussionProvider } from '../research/discussion/types.js';
import {
  startServer,
  type RouteHandler,
  type TestServer,
} from '../research/test-support/site-server.js';
import type { RunCaseDeps } from '../run-case.js';
import { byTask, goodExtraction } from '../stages/test-support/fixtures.js';

/**
 * Shared helpers for tests of runCase, the batch and the commands built on them: a deterministic fake
 * model that answers every stage, a discussion provider that never touches the network, and a local
 * fixture website. Nothing here needs credentials or the internet.
 */

type Reply = (request: LlmRequest, n: number) => FakeReply | Promise<FakeReply>;
export type ModelHandlers = Record<string, Reply>;

const q = (ids: string[], prompt: string, difficulty = 2) => ({
  requirement_ids: ids,
  prompt,
  answer_outline: '- first point\n- second point\n- third point',
  difficulty,
});

/** A model that does everything right for DETAILED_JD (the Acme posting), covering every requirement. */
export function goodModelHandlers(over: ModelHandlers = {}): ModelHandlers {
  return {
    'extract-requirements': () => goodExtraction(),
    // No claims: the brief falls back to the website's own wording, deterministically.
    'company-brief': () => ({
      what_they_do: 'Acme builds rockets.',
      summary: 'Acme builds rockets.',
      claims: [],
    }),
    'questions:technical': () => ({
      questions: [
        q(['r1'], 'Explain the Node.js event loop.', 3),
        q(['r2'], 'How would you model orders in PostgreSQL?'),
        q(['r5', 'r6'], 'When would you reach for Kafka or Kubernetes?', 3),
        q(['r7'], 'Tell us about an open source contribution.', 1),
        q(['r8'], 'What attracts you to Rust?', 1),
      ],
    }),
    'questions:behavioural': () => ({
      questions: [
        q(['r3'], 'Tell me about mentoring a junior engineer.'),
        q(['r4'], 'Describe a hard written update you wrote.'),
      ],
    }),
    'questions:system-design': () => ({
      questions: [q(['r1', 'r2'], 'Design a payments ledger.', 3)],
    }),
    'questions:company-fit': () => ({
      questions: [q([], 'Why Acme?'), q(['r7'], 'How do you feel about working in public?')],
    }),
    flashcards: () => ({
      flashcards: [
        {
          front: 'What is the event loop?',
          back: 'Phases and microtasks.',
          requirement_ids: ['r1'],
        },
        {
          front: 'What is a covering index?',
          back: 'An index that satisfies a query alone.',
          requirement_ids: ['r2'],
        },
      ],
    }),
    ...over,
  };
}

/** A discussion provider that finds nothing and never makes a request. */
export const noDiscussion: DiscussionProvider = {
  id: 'none',
  async search() {
    return {
      provider: 'none',
      status: 'no_results',
      items: [],
      queries: [],
      retrieved_at: '2026-01-01T00:00:00.000Z',
      error: null,
      limitations: [],
    };
  },
};

export interface CaseHarness {
  deps: RunCaseDeps;
  provider: FakeProvider;
}

export interface CaseHarnessOptions {
  handlers?: ModelHandlers;
  clock?: Clock;
  allowLoopback?: boolean;
  nodeEnv?: string;
  caseDeadlineMs?: number;
  /** Model client retries. The default is small so failing tests stay fast. */
  maxRetries?: number;
  /** Extra research overrides. Politeness and retries are switched off by default. */
  research?: RunCaseDeps['research'];
}

/** Dependencies for runCase / runBatch: a fake model behind the real client, and a local-only research setup. */
export function makeCaseHarness(options: CaseHarnessOptions = {}): CaseHarness {
  const route = byTask(goodModelHandlers(options.handlers));
  const provider = createFakeProvider((request, n) => route(request, n));
  const deps: RunCaseDeps = {
    createLlm: ({ deadline, clock }) =>
      createLlmClient({
        provider,
        clock,
        deadline,
        random: () => 1,
        maxRetries: options.maxRetries ?? 1,
        baseDelayMs: 1,
        maxDelayMs: 2,
        maxConcurrency: 3,
      }),
    research: {
      discussionProvider: noDiscussion,
      minIntervalMs: 0,
      requestTimeoutMs: 2000,
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 1 },
      ...options.research,
    },
    allowLoopback: options.allowLoopback ?? true,
    ...(options.nodeEnv === undefined ? {} : { nodeEnv: options.nodeEnv }),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.caseDeadlineMs === undefined ? {} : { caseDeadlineMs: options.caseDeadlineMs }),
  };
  return { deps, provider };
}

export interface FixtureSite {
  server: TestServer;
  /** `${origin}${path}`, for example url('/acme/'). */
  url(path?: string): string;
  close(): Promise<void>;
}

export async function startFixtureSite(routes: Record<string, RouteHandler>): Promise<FixtureSite> {
  const server = await startServer(routes);
  return { server, url: (path = '/') => `${server.origin}${path}`, close: () => server.close() };
}

/** A URL on 127.0.0.1 where nothing is listening: the server is started to claim a port, then closed. */
export async function closedPortUrl(): Promise<string> {
  const server = await startServer({});
  const url = `${server.origin}/`;
  await server.close();
  return url;
}
