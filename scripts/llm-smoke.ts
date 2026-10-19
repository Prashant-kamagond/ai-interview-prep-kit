/**
 * LIVE SMOKE TEST — not part of `pnpm test`, never run in CI.
 *
 * Runs the real generation stages against the real Gemini API with the key from .env, and
 * reports what that cost: model calls, retries, repairs, tokens and wall-clock time per stage.
 * Use it to check your own quota and latency (the numbers depend on your Google AI Studio
 * project) before relying on the five-case batch budget.
 *
 *   pnpm llm:smoke                      sample posting + built-in sample research (no web crawl)
 *   pnpm llm:smoke --url https://posthog.com/   crawl a real site first, then generate
 *   pnpm llm:smoke --days 7 --jd path/to/jd.txt
 *
 * It sends the job description and page text to Google. On the free tier Google may use that
 * content to improve its products and humans may review it, so do not use confidential or
 * personal data. The API key is read from the environment and is never printed or written.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  createLlmClientFromConfig,
  createResearchPolicy,
  generateKit,
  GenerationFailure,
  loadLlmConfig,
  LlmError,
  researchCompany,
  type LlmEvent,
  type ResearchResult,
} from '@trao/pipeline';

const SAMPLE_JD = `Senior Backend Engineer — Remote (EU time zones)
Acme Payments

About the role
We are building the payments platform that thousands of merchants rely on.

What you will do:
- Design and operate the payment APIs used by merchants
- Mentor engineers and improve our engineering practices

Requirements:
- 5+ years of professional experience with Node.js
- Strong knowledge of PostgreSQL and data modelling
- Experience mentoring junior engineers
- Excellent written communication in English

Nice to have:
* Experience with Kafka or other event streaming
* Familiarity with Kubernetes

Bonus points if you have contributed to open source.
Experience with Rust is a plus.
`;

/** A small, hand-written research result so the stages can be measured without crawling. */
function sampleResearch(): ResearchResult {
  const at = new Date().toISOString();
  const page = (
    url: string,
    role: 'home' | 'about' | 'hiring-process',
    text: string,
    mentions: string[] = [],
  ) => ({
    url,
    requested_url: url,
    title: 'Acme Payments',
    description: 'Payment infrastructure for online merchants.',
    headings: [],
    text,
    fetched_at: at,
    status: 200,
    content_type: 'text/html',
    depth: role === 'home' ? 0 : 1,
    role,
    classification: {
      role: role === 'home' ? ('other' as const) : role,
      hiring_score: 0,
      process_score: mentions.length * 2,
      evidence: [],
    },
    interview_mentions: mentions,
    links_found: 0,
    truncated: false,
    content_hash: url,
    provenance: 'observed' as const,
  });
  const pages = [
    page(
      'https://acme.example/',
      'home',
      'Acme builds payment infrastructure for online merchants. Our APIs process card payments and payouts in 30 countries.',
    ),
    page(
      'https://acme.example/about',
      'about',
      'Acme was founded in 2016 and has 200 employees across Europe. We value written communication and small teams.',
    ),
    page(
      'https://acme.example/handbook/hiring-process',
      'hiring-process',
      'Every candidate starts with a recruiter screen. Next comes a take-home project that should take about four hours. The final stage is a system design interview.',
      [
        'Next comes a take-home project that should take about four hours.',
        'The final stage is a system design interview.',
      ],
    ),
  ];
  return {
    researched_at: at,
    company: { name: 'Acme Payments', name_source: 'provided', inferred: false },
    crawl: {
      company_url: 'https://acme.example/',
      status: 'ok',
      pages,
      failures: [],
      skipped: [],
      robots: [],
      hiring: {
        found: true,
        process_found: true,
        page_urls: [pages[2]!.url],
        method: 'content-heuristic',
      },
      limitations: [],
      stats: { requests: 0, pages_fetched: pages.length, elapsed_ms: 0, budget_exhausted: null },
    },
    discussion: {
      provider: 'sample',
      status: 'no_results',
      items: [],
      queries: [],
      retrieved_at: at,
      error: null,
      limitations: [],
    },
    pages_used: pages.map((p) => p.url),
    discussion_urls: [],
    limitations: [],
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    // npm and pnpm may forward a literal "--" separator; it is not an argument.
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      url: { type: 'string' },
      jd: { type: 'string' },
      days: { type: 'string' },
      budget: { type: 'string' },
    },
    strict: true,
  });
  const days = Number(values.days ?? 5);
  const budgetMs = Number(values.budget ?? 8 * 60_000);
  const jd = values.jd ? readFileSync(values.jd, 'utf8') : SAMPLE_JD;

  const config = loadLlmConfig(); // fails with a clear message if LLM_API_KEY is missing
  console.log(
    `model=${config.model} provider=${config.provider} thinking=${config.thinkingLevel} ` +
      `timeout=${config.requestTimeoutMs}ms retries=${config.maxRetries} concurrency=${config.maxConcurrency}`,
  );

  const events: (LlmEvent & { at: number })[] = [];
  const started = Date.now();
  const llm = createLlmClientFromConfig(config, {
    deadline: started + budgetMs,
    onEvent: (e) => events.push({ ...e, at: Date.now() - started }),
  });

  let research: ResearchResult;
  if (values.url) {
    const policy = createResearchPolicy({
      companyUrl: values.url,
      allowLoopback: false,
      nodeEnv: 'production',
    });
    const t0 = Date.now();
    research = await researchCompany({ companyUrl: values.url }, { policy });
    console.log(
      `research: ${research.crawl.status}, ${research.crawl.pages.length} pages, discussion=${research.discussion.status}, ${Date.now() - t0} ms`,
    );
  } else {
    research = sampleResearch();
  }

  try {
    const result = await generateKit({ jd, days, research }, { llm });
    const byCategory: Record<string, number> = {};
    for (const q of result.kit.questions)
      byCategory[q.category] = (byCategory[q.category] ?? 0) + 1;

    const summary = {
      model: config.model,
      timestamp: new Date().toISOString(),
      status: result.status,
      incompleteReasons: result.incompleteReasons,
      requirements: result.kit.role.requirements.map(
        (r) => `${r.id} [${r.priority}/${r.kind}] ${r.text}`,
      ),
      questions: { total: result.kit.questions.length, byCategory },
      flashcards: result.kit.flashcards.length,
      coverage: result.kit.coverage,
      coverageStopped: result.extras.coverage.stoppedBecause,
      scheduleDays: result.kit.schedule.days.length,
      brief: {
        provenance: result.extras.briefProvenance,
        sources: result.kit.company_brief.sources,
      },
      limitations: result.limitations,
      modelCalls: {
        logical: result.stats.logicalCalls,
        providerRequests: result.stats.providerCalls,
        retries: result.stats.retries,
        repairs: result.stats.repairs,
        byStage: result.stats.byStage,
      },
      tokens: {
        input: result.stats.inputTokens,
        output: result.stats.outputTokens,
        thinking: result.stats.thoughtTokens,
      },
      timingsMs: result.timingsMs,
      wallClockMs: Date.now() - started,
      slowestAttempts: events
        .filter(
          (e): e is Extract<LlmEvent, { type: 'attempt' }> & { at: number } => e.type === 'attempt',
        )
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 5)
        .map((e) => ({
          stage: e.stage,
          attempt: e.attempt,
          outcome: e.outcome,
          code: e.code ?? null,
          ms: e.durationMs,
        })),
      attemptErrors: events.filter((e) => e.type === 'attempt' && e.outcome === 'error').length,
      // Why retries happened and how long each waited: this decides whether five cases fit in 15 minutes.
      failedAttempts: events
        .filter(
          (e): e is Extract<LlmEvent, { type: 'attempt' }> & { at: number } =>
            e.type === 'attempt' && e.outcome === 'error',
        )
        .map((e) => ({
          stage: e.stage,
          attempt: e.attempt,
          code: e.code ?? null,
          ms: e.durationMs,
          atMs: e.at,
        })),
      retryWaits: events
        .filter(
          (e): e is Extract<LlmEvent, { type: 'retry' }> & { at: number } => e.type === 'retry',
        )
        .map((e) => ({
          stage: e.stage,
          afterAttempt: e.attempt,
          code: e.code,
          waitMs: Math.round(e.delayMs),
        })),
    };
    console.log(JSON.stringify(summary, null, 2));

    mkdirSync('out', { recursive: true });
    const file = `out/smoke-${Date.now()}.json`;
    writeFileSync(file, JSON.stringify({ summary, kit: result.kit }, null, 2));
    console.log(`full result written to ${file}`);
  } catch (err) {
    if (err instanceof GenerationFailure) {
      console.error(
        `generation failed: code=${err.code} stage=${err.stage} message=${err.message}`,
      );
      console.error(
        `wall clock ${Date.now() - started} ms, provider requests ${llm.stats.providerCalls}`,
      );
      process.exitCode = 3;
    } else if (err instanceof LlmError) {
      console.error(`LLM error: ${err.code}: ${err.message}`);
      process.exitCode = 3;
    } else {
      throw err;
    }
  }
}

main().catch((err: unknown) => {
  // Configuration errors carry no secrets; anything else is reduced to name and message.
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : 'unexpected error');
  process.exitCode = 1;
});
