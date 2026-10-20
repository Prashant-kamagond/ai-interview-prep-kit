import { generationRequestSchema, type Kit } from '@trao/contracts';
import type { LlmClient, LlmStats } from './llm/client.js';
import { LlmError, type LlmErrorCode } from './llm/errors.js';
import { systemClock, type Clock } from './research/clock.js';
import {
  createResearchPolicy,
  researchCompany,
  type ResearchConfig,
  type ResearchResult,
} from './research/research.js';
import type { CrawlStatus } from './research/types.js';
import { GenerationFailure, generateKit, type GenerationResult } from './stages/generate.js';

/**
 * One case, start to finish: research the company, generate the kit, validate it. The web app's job
 * runner and the batch command both call this function and nothing else, so they cannot drift apart.
 *
 * It either returns a kit (possibly an honestly limited one) or throws a CaseFailure with a stable
 * code and a message that is safe to show to a user. It never throws because a website is down:
 * that is reported as COMPANY_UNREACHABLE (or a sibling code) when nothing could be retrieved.
 */

export const CASE_FAILURE_CODES = [
  'INVALID_INPUT',
  'COMPANY_URL_INVALID',
  'COMPANY_URL_BLOCKED',
  'COMPANY_UNREACHABLE',
  'COMPANY_BLOCKED_BY_ROBOTS',
  'COMPANY_RESEARCH_FAILED',
  'LLM_NOT_CONFIGURED',
  'LLM_AUTH_FAILED',
  'LLM_REQUEST_REJECTED',
  'LLM_MODEL_NOT_FOUND',
  'LLM_QUOTA_EXHAUSTED',
  'LLM_RATE_LIMITED',
  'LLM_UNAVAILABLE',
  'LLM_TIMEOUT',
  'LLM_INVALID_OUTPUT',
  'LLM_CONTENT_BLOCKED',
  'DEADLINE_EXCEEDED',
  'KIT_INVALID',
  'CONFIGURATION_ERROR',
  'INTERNAL_ERROR',
] as const;
export type CaseFailureCode = (typeof CASE_FAILURE_CODES)[number];

export class CaseFailure extends Error {
  constructor(
    readonly code: CaseFailureCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CaseFailure';
  }
}

export interface CaseInput {
  jd: string;
  company_url: string;
  days: number;
}

export interface RunCaseDeps {
  /** Builds the model client for this case. It must enforce `deadline` (clock scale) on every call. */
  createLlm(args: { deadline: number; clock: Clock }): LlmClient;
  /** Test seam: replaces researchCompany, for example to observe the budget it is given. */
  researchFn?: typeof researchCompany;
  /** Per-call research overrides (resolver, discussion provider, politeness, crawl limits ...). */
  research?: Omit<ResearchConfig, 'policy' | 'clock' | 'totalTimeoutMs'>;
  /** Permit the company URL's own loopback host:port (local fixture sites). Refused in production. */
  allowLoopback?: boolean;
  nodeEnv?: string | undefined;
  clock?: Clock;
  /** Everything for this case (research and generation) must finish within this long. Default 90 s. */
  caseDeadlineMs?: number;
  /** An absolute deadline (clock scale) from the caller, for example the batch's. */
  deadline?: number;
  /** The share of the case budget research may use; the rest is kept for the model. Default 0.4. */
  researchShare?: number;
  /** Receives the current stage and a 0-100 progress value. Errors from it are ignored. */
  onProgress?: (stage: string, progress: number) => void | Promise<void>;
}

export interface CaseResult {
  /** The Appendix A kit, already validated. */
  kit: Kit;
  /** `incomplete` means a must-have has no question or a stage failed; the kit is still valid and says what it has. */
  status: GenerationResult['status'];
  incompleteReasons: string[];
  /** Everything that could not be done, found or verified. Appendix A has no field for it, so it is returned here. */
  limitations: string[];
  warnings: GenerationResult['warnings'];
  research: {
    crawlStatus: CrawlStatus;
    pagesFetched: number;
    hiringPageFound: boolean;
    companyNameInferred: boolean;
  };
  stats: LlmStats;
  timingsMs: Record<string, number>;
}

export const DEFAULT_CASE_DEADLINE_MS = 90_000;
const DEFAULT_RESEARCH_SHARE = 0.4;

const LLM_CODE_MAP: Partial<Record<LlmErrorCode | 'INVALID_KIT', CaseFailureCode>> = {
  MISSING_CREDENTIALS: 'LLM_NOT_CONFIGURED',
  AUTH_FAILED: 'LLM_AUTH_FAILED',
  INVALID_REQUEST: 'LLM_REQUEST_REJECTED',
  MODEL_NOT_FOUND: 'LLM_MODEL_NOT_FOUND',
  QUOTA_EXHAUSTED: 'LLM_QUOTA_EXHAUSTED',
  RATE_LIMITED: 'LLM_RATE_LIMITED',
  TIMEOUT: 'LLM_TIMEOUT',
  BUDGET_EXHAUSTED: 'DEADLINE_EXCEEDED',
  PROVIDER_UNAVAILABLE: 'LLM_UNAVAILABLE',
  NETWORK_ERROR: 'LLM_UNAVAILABLE',
  INVALID_OUTPUT: 'LLM_INVALID_OUTPUT',
  OUTPUT_TRUNCATED: 'LLM_INVALID_OUTPUT',
  CONTENT_BLOCKED: 'LLM_CONTENT_BLOCKED',
  INVALID_KIT: 'KIT_INVALID',
};

/** Maps a failure of the model layer to a case failure. The messages come from LlmError and are curated. */
export function failureFromGeneration(err: unknown): CaseFailure {
  if (err instanceof GenerationFailure) {
    const code = LLM_CODE_MAP[err.code] ?? 'INTERNAL_ERROR';
    return new CaseFailure(code, err.message, { cause: err });
  }
  if (err instanceof LlmError) {
    return new CaseFailure(LLM_CODE_MAP[err.code] ?? 'INTERNAL_ERROR', err.message, { cause: err });
  }
  return new CaseFailure('INTERNAL_ERROR', 'An unexpected error stopped this case.', {
    cause: err,
  });
}

/** What to say when research found nothing at all to build on. */
function researchFailure(research: ResearchResult): CaseFailure {
  const crawl = research.crawl;
  const why = crawl.limitations[0] ?? 'No page of the company website could be retrieved.';
  switch (crawl.status) {
    case 'rejected': {
      const first = crawl.failures[0]?.code;
      return new CaseFailure(
        first === 'BLOCKED_ADDRESS' ? 'COMPANY_URL_BLOCKED' : 'COMPANY_URL_INVALID',
        why,
      );
    }
    case 'unreachable':
      return new CaseFailure('COMPANY_UNREACHABLE', `Company site unreachable. ${why}`);
    case 'blocked-by-robots': {
      // RFC 9309: a robots.txt that cannot be fetched at all is treated as "off limits". That is a site
      // that is down or not answering, not a site that forbids us, so it is reported as unreachable.
      const silent =
        crawl.robots.length > 0 && crawl.robots.every((r) => r.status === 'unreachable');
      return silent
        ? new CaseFailure('COMPANY_UNREACHABLE', `Company site unreachable. ${why}`)
        : new CaseFailure('COMPANY_BLOCKED_BY_ROBOTS', why);
    }
    default:
      return new CaseFailure('COMPANY_RESEARCH_FAILED', why);
  }
}

export async function runCase(input: CaseInput, deps: RunCaseDeps): Promise<CaseResult> {
  const clock = deps.clock ?? systemClock;
  const started = clock.now();
  const progress = async (stage: string, value: number): Promise<void> => {
    try {
      await deps.onProgress?.(stage, value);
    } catch {
      // progress reporting must never break generation
    }
  };

  // The same rules the API applies: a batch case and a web request are interchangeable.
  const parsed = generationRequestSchema.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`)
      .join('; ');
    throw new CaseFailure('INVALID_INPUT', `The case is not valid (${problems}).`);
  }
  const request = parsed.data;

  const deadline = Math.min(
    started + (deps.caseDeadlineMs ?? DEFAULT_CASE_DEADLINE_MS),
    deps.deadline ?? Number.POSITIVE_INFINITY,
  );
  const budget = deadline - started;
  if (budget <= 0) {
    throw new CaseFailure('DEADLINE_EXCEEDED', 'There was no time left to start this case.');
  }

  await progress('researching', 5);
  let policy;
  try {
    policy = createResearchPolicy({
      companyUrl: request.company_url,
      allowLoopback: deps.allowLoopback ?? false,
      nodeEnv: deps.nodeEnv,
    });
  } catch (err) {
    throw new CaseFailure(
      'CONFIGURATION_ERROR',
      'Local company sites are not permitted in this environment.',
      { cause: err },
    );
  }

  const researchStarted = clock.now();
  const research = await (deps.researchFn ?? researchCompany)(
    { companyUrl: request.company_url },
    {
      ...deps.research,
      policy,
      clock,
      totalTimeoutMs: Math.max(
        1000,
        Math.floor(budget * (deps.researchShare ?? DEFAULT_RESEARCH_SHARE)),
      ),
    },
  );
  const researchMs = clock.now() - researchStarted;
  // A site that yields no page at all gives the model nothing to say about the company: report why,
  // with a stable code, instead of inventing a brief. A site that yields some pages is enough.
  if (research.crawl.pages.length === 0) throw researchFailure(research);

  await progress('generating', 40);
  let result: GenerationResult;
  try {
    const llm = deps.createLlm({ deadline, clock });
    result = await generateKit({ jd: request.jd, days: request.days, research }, { llm, clock });
  } catch (err) {
    throw failureFromGeneration(err);
  }

  await progress('finalizing', 95);
  return {
    kit: result.kit,
    status: result.status,
    incompleteReasons: result.incompleteReasons,
    limitations: result.limitations,
    warnings: result.warnings,
    research: {
      crawlStatus: research.crawl.status,
      pagesFetched: research.crawl.pages.length,
      hiringPageFound: research.crawl.hiring.found,
      companyNameInferred: research.company.inferred,
    },
    stats: result.stats,
    timingsMs: { ...result.timingsMs, research: researchMs, total: clock.now() - started },
  };
}
