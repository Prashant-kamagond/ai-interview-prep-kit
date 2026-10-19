import type { Flashcard, Kit, Question, QuestionCategory } from '@trao/contracts';
import {
  allocateSchedule,
  buildCoverage,
  checkCoverage,
  validateKit,
  type ValidationIssue,
} from '@trao/core';
import type { LlmClient, LlmStats } from '../llm/client.js';
import { LlmError, type LlmErrorCode } from '../llm/errors.js';
import { systemClock, type Clock } from '../research/clock.js';
import type { ResearchResult } from '../research/research.js';
import {
  generateCompanyBrief,
  deterministicBrief,
  type CompanyBriefResult,
} from './company-brief.js';
import {
  closeCoverageGaps,
  type CoverageLoopResult,
  type RoundSummary,
  type StopReason,
} from './coverage-loop.js';
import { extractRequirements } from './extract-requirements.js';
import { generateFlashcards, type FlashcardResult } from './flashcards.js';
import {
  buildQuestionContext,
  generateCategoryQuestions,
  type CategoryResult,
  type DraftQuestion,
} from './questions.js';

/**
 * Composes the generation stages into a kit. It is the same code the web app and the batch CLI
 * will call: extract requirements, research-based brief, one call per question category, a
 * bounded deterministic gap-filling loop, flashcards, then the deterministic schedule, and a final
 * check of the whole kit with the shared validator.
 *
 * Failure policy:
 *  - problems with the setup itself (no or rejected key, unknown model, rejected request shape)
 *    stop the run: nothing later could work;
 *  - without the role breakdown nothing can be built, so any failure of that stage is terminal;
 *  - after that, a failed stage is recorded and the kit is built from what exists, flagged
 *    incomplete; once the quota or the time budget is gone, no further model calls are made.
 *
 * Nothing the model says reaches the kit unless application code accepted it.
 */

export class GenerationFailure extends Error {
  constructor(
    readonly code: LlmErrorCode | 'INVALID_KIT',
    readonly stage: string,
    message: string,
    readonly limitations: string[] = [],
    readonly issues?: string[],
  ) {
    super(message);
    this.name = 'GenerationFailure';
  }
}

export interface GenerateKitInput {
  jd: string;
  days: number;
  research: ResearchResult;
}

export interface GenerateKitDeps {
  llm: LlmClient;
  clock?: Clock;
  /** Test seam: the kit validator. Defaults to the shared validateKit. */
  validate?: typeof validateKit;
}

export interface GenerationResult {
  /** The Appendix A kit, validated against the shared schema and invariants. */
  kit: Kit;
  /** `complete` only if no stage failed and no must-have is left without a question. */
  status: 'complete' | 'incomplete';
  incompleteReasons: string[];
  /** Everything that could not be done, found or verified, in plain language. */
  limitations: string[];
  /** Non-blocking findings from kit validation. */
  warnings: ValidationIssue[];
  /** Information that does not fit in the Appendix A kit but should not be lost. */
  extras: {
    briefEvidence: CompanyBriefResult['evidence'];
    briefProvenance: CompanyBriefResult['provenance'];
    discussionUrls: string[];
    coverage: { stoppedBecause: StopReason; rounds: RoundSummary[] };
    sparse: boolean;
    dropped: Record<string, number>;
  };
  /** Model-call accounting: calls, retries, repairs and tokens. */
  stats: LlmStats;
  timingsMs: Record<string, number>;
}

/** Problems with the setup, not with a particular request: retrying or continuing cannot help. */
const CONFIG_FATAL: ReadonlySet<LlmErrorCode> = new Set([
  'MISSING_CREDENTIALS',
  'AUTH_FAILED',
  'INVALID_REQUEST',
  'MODEL_NOT_FOUND',
]);

function emptyCategory(category: QuestionCategory): CategoryResult {
  return {
    category,
    questions: [],
    dropped: { unknownRefs: 0, outOfScopeRefs: 0, withoutRefs: 0, duplicates: 0 },
  };
}

/** "about 20 hours", for telling a person when a daily quota comes back. */
function humanWait(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 55)
    return `${Math.max(1, Math.round(minutes))} minute${Math.round(minutes) === 1 ? '' : 's'}`;
  if (minutes < 90) return '1 hour';
  return `${Math.round(minutes / 60)} hours`;
}

/** For a quota error that says when it resets, a short sentence saying so ('' otherwise). */
function resetHint(err: LlmError): string {
  return err.code === 'QUOTA_EXHAUSTED' && err.retryAfterMs !== undefined && err.retryAfterMs > 0
    ? ` It resets in about ${humanWait(err.retryAfterMs)}.`
    : '';
}

function asFailure(err: unknown, stage: string): never {
  if (err instanceof LlmError)
    throw new GenerationFailure(err.code, stage, `${err.message}${resetHint(err)}`, [], err.issues);
  throw err;
}

export async function generateKit(
  input: GenerateKitInput,
  deps: GenerateKitDeps,
): Promise<GenerationResult> {
  const { llm, research } = { llm: deps.llm, research: input.research };
  const clock = deps.clock ?? systemClock;
  const startedAt = clock.now();
  const timingsMs: Record<string, number> = {};
  const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = clock.now();
    try {
      return await fn();
    } finally {
      timingsMs[label] = (timingsMs[label] ?? 0) + (clock.now() - t0);
    }
  };

  const state = {
    exhausted: null as LlmError | null,
    limitations: [] as string[],
    incomplete: [] as string[],
  };

  /** Runs one stage. Setup errors stop the run; other model failures degrade to a fallback. */
  const guarded = async <T>(
    stage: string,
    fn: () => Promise<T>,
    fallback: (err: LlmError) => T,
  ): Promise<T> => {
    if (state.exhausted) {
      state.limitations.push(`${stage} was skipped: ${state.exhausted.message}`);
      state.incomplete.push(`${stage} skipped (${state.exhausted.code})`);
      return fallback(state.exhausted);
    }
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      if (CONFIG_FATAL.has(err.code))
        throw new GenerationFailure(err.code, stage, err.message, [...state.limitations]);
      if (err.code === 'QUOTA_EXHAUSTED' || err.code === 'BUDGET_EXHAUSTED')
        state.exhausted ??= err;
      state.limitations.push(`${stage} failed (${err.code}): ${err.message}${resetHint(err)}`);
      state.incomplete.push(`${stage} failed (${err.code})`);
      return fallback(err);
    }
  };

  // 1. The role breakdown. Nothing can be built without it.
  const role = await timed('extract-requirements', () =>
    extractRequirements(llm, { jd: input.jd }).catch((err: unknown) =>
      asFailure(err, 'extract-requirements'),
    ),
  );
  const roleInfo = { title: role.title, seniority: role.seniority };

  // 2. The brief and three of the four question categories do not depend on each other.
  const baseContext = buildQuestionContext(roleInfo, role.requirements, research, '');
  const [brief, technical, behavioural, systemDesign] = await timed('questions', () =>
    Promise.all([
      timed('company-brief', () =>
        guarded(
          'company-brief',
          () => generateCompanyBrief(llm, research),
          (err) =>
            deterministicBrief(
              research,
              `The model could not be used for the brief (${err.code}).`,
            ),
        ),
      ),
      guarded(
        'questions:technical',
        () => generateCategoryQuestions(llm, 'technical', baseContext),
        () => emptyCategory('technical'),
      ),
      guarded(
        'questions:behavioural',
        () => generateCategoryQuestions(llm, 'behavioural', baseContext),
        () => emptyCategory('behavioural'),
      ),
      guarded(
        'questions:system-design',
        () => generateCategoryQuestions(llm, 'system-design', baseContext),
        () => emptyCategory('system-design'),
      ),
    ]),
  );

  // 3. Company-fit questions use what the brief learned about the company.
  const context = buildQuestionContext(
    roleInfo,
    role.requirements,
    research,
    brief.provenance === 'none' ? '' : brief.brief.what_they_do,
  );
  const companyFit = await timed('questions', () =>
    guarded(
      'questions:company-fit',
      () => generateCategoryQuestions(llm, 'company-fit', context),
      () => emptyCategory('company-fit'),
    ),
  );
  if (companyFit.skipped)
    state.limitations.push(`Company-fit questions were skipped: ${companyFit.skipped}`);

  // Ids are assigned here, in a fixed category order, whichever call finished first.
  const drafts: DraftQuestion[] = [technical, behavioural, systemDesign, companyFit].flatMap(
    (r) => r.questions,
  );
  const initialQuestions: Question[] = drafts.map((d, i) => ({ id: `q${i + 1}`, ...d }));

  // 4. The second pass: deterministic coverage decides, the model only fills gaps it is told about.
  let loop: CoverageLoopResult;
  try {
    loop = await timed('coverage', () =>
      closeCoverageGaps({
        requirements: role.requirements,
        questions: initialQuestions,
        generate: async (group) => {
          if (state.exhausted) throw state.exhausted;
          return (
            await generateCategoryQuestions(llm, group.category, context, {
              targetIds: group.requirementIds,
            })
          ).questions;
        },
      }),
    );
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    if (CONFIG_FATAL.has(err.code))
      throw new GenerationFailure(err.code, 'coverage', err.message, [...state.limitations]);
    state.exhausted ??= err;
    state.limitations.push(
      `coverage gap filling failed (${err.code}): ${err.message}${resetHint(err)}`,
    );
    state.incomplete.push(`coverage gap filling failed (${err.code})`);
    loop = {
      questions: initialQuestions,
      report: checkCoverage(role.requirements, initialQuestions),
      passes: 1,
      rounds: [],
      stoppedBecause: 'failed',
      limitations: [],
    };
  }

  // 5. Flashcards over the final questions.
  const flashcardResult: FlashcardResult = await timed('flashcards', () =>
    guarded(
      'flashcards',
      () =>
        generateFlashcards(llm, {
          role: roleInfo,
          requirements: role.requirements,
          questions: loop.questions.map((q) => ({
            id: q.id,
            category: q.category,
            prompt: q.prompt,
            requirement_ids: q.requirement_ids,
          })),
        }),
      () => ({ flashcards: [], dropped: { unknownRefs: 0, withoutRefs: 0, duplicates: 0 } }),
    ),
  );
  const flashcards: Flashcard[] = flashcardResult.flashcards.map((f, i) => ({
    id: `f${i + 1}`,
    ...f,
  }));

  // 6. The schedule is arithmetic, not a model call. Then the whole kit is checked.
  const schedule = allocateSchedule({
    days: input.days,
    questions: loop.questions,
    requirements: role.requirements,
  });
  const kit: Kit = {
    source: {
      company: research.company.name ?? role.company,
      company_url: research.crawl.company_url,
      role: role.title,
      location: role.location,
      jd_chars: input.jd.length,
      researched_at: research.researched_at,
      pages_used: research.pages_used,
    },
    company_brief: brief.brief,
    role: {
      title: role.title,
      seniority: role.seniority,
      responsibilities: role.responsibilities,
      requirements: role.requirements,
    },
    questions: loop.questions,
    flashcards,
    schedule,
    coverage: buildCoverage(loop.report, loop.passes),
  };

  const validation = (deps.validate ?? validateKit)(kit, { requestedDays: input.days });
  if (!validation.ok) {
    throw new GenerationFailure(
      'INVALID_KIT',
      'assemble',
      'The generated kit failed validation.',
      [...state.limitations],
      validation.issues.filter((i) => i.severity === 'error').map((i) => `${i.code} at ${i.path}`),
    );
  }

  // 7. Report honestly.
  const incompleteReasons = [...state.incomplete];
  if (loop.report.uncovered_must_ids.length > 0) {
    incompleteReasons.push(
      `must-have requirement(s) without a question: ${loop.report.uncovered_must_ids.join(', ')}`,
    );
  }
  if (
    role.requirements.length === 0 &&
    !role.sparse &&
    role.notes.droppedUngrounded.requirements > 0
  ) {
    incompleteReasons.push('the requirements proposed for this posting could not be verified');
  }

  const limitations = [
    ...new Set([
      ...research.limitations,
      ...role.limitations,
      ...brief.limitations,
      ...state.limitations,
      ...loop.limitations,
    ]),
  ];
  timingsMs.total = clock.now() - startedAt;

  return {
    kit,
    status: incompleteReasons.length === 0 ? 'complete' : 'incomplete',
    incompleteReasons,
    limitations,
    warnings: validation.issues.filter((i) => i.severity === 'warning'),
    extras: {
      briefEvidence: brief.evidence,
      briefProvenance: brief.provenance,
      discussionUrls: research.discussion_urls,
      coverage: { stoppedBecause: loop.stoppedBecause, rounds: loop.rounds },
      sparse: role.sparse,
      dropped: {
        requirements: role.notes.droppedUngrounded.requirements,
        responsibilities: role.notes.droppedUngrounded.responsibilities,
        priorityOverrides: role.notes.priorityOverrides,
        briefClaims: brief.dropped.claims,
        unknownQuestionRefs: [technical, behavioural, systemDesign, companyFit].reduce(
          (n, r) => n + r.dropped.unknownRefs,
          0,
        ),
        flashcardUnknownRefs: flashcardResult.dropped.unknownRefs,
      },
    },
    stats: structuredClone(llm.stats),
    timingsMs,
  };
}
