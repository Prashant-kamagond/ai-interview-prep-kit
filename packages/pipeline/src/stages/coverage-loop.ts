import type { Question, Requirement } from '@trao/contracts';
import { checkCoverage, type CoverageReport } from '@trao/core';
import { isFatalForRun, LlmError } from '../llm/errors.js';
import { normalizeWords } from '../research/text-match.js';
import type { DraftQuestion } from './questions.js';

/**
 * The second pass: find requirements with no question and ask for exactly those, a bounded number
 * of times.
 *
 * `coverage.passes` counts the deterministic coverage checks that were run. Every check follows
 * one generation pass (the initial draft, then each gap-filling round), so it is also the number
 * of generation passes. The default budget is 3 checks: the draft plus at most two gap rounds. A
 * gap that survives two targeted attempts is rarely closed by a third, while each pass costs
 * latency and tokens on a rate-limited free tier.
 *
 * The model never judges coverage. After every round `checkCoverage` (pure code in
 * @trao/core) recomputes it from the questions' requirement ids; references to ids that do not
 * exist count for nothing. The loop stops when must-haves are covered, when a round closes
 * nothing, when the budget is spent, or when the model cannot be used: and whatever is still
 * uncovered is reported, never hidden.
 */

export const MAX_COVERAGE_PASSES = 3;

export interface GapGroup {
  /** The category whose generator should handle this group. */
  category: 'technical' | 'behavioural';
  requirementIds: string[];
}

/** Produces draft questions for one group of uncovered requirements. */
export type GapGenerator = (group: GapGroup) => Promise<DraftQuestion[]>;

export type StopReason =
  'covered' | 'only-nice-uncovered' | 'no-progress' | 'budget' | 'failed' | 'no-requirements';

export interface RoundSummary {
  /** The coverage-check number this round produced (2 for the first gap round). */
  pass: number;
  targeted: string[];
  questionsAdded: number;
  stillUncovered: string[];
  failedGroups: number;
}

export interface CoverageLoopResult {
  questions: Question[];
  report: CoverageReport;
  /** Coverage checks run (= generation passes: the draft plus each completed gap round). */
  passes: number;
  rounds: RoundSummary[];
  stoppedBecause: StopReason;
  limitations: string[];
}

function nextIdNumber(questions: readonly Question[]): number {
  let max = 0;
  for (const q of questions) {
    const n = /^q(\d+)$/.exec(q.id)?.[1];
    if (n) max = Math.max(max, Number(n));
  }
  return max + 1;
}

function groupsFor(requirements: readonly Requirement[], uncovered: readonly string[]): GapGroup[] {
  const open = new Set(uncovered);
  const wanted = requirements.filter((r) => open.has(r.id));
  const technical = wanted.filter((r) => r.kind !== 'behavioural').map((r) => r.id);
  const behavioural = wanted.filter((r) => r.kind === 'behavioural').map((r) => r.id);
  return [
    ...(technical.length > 0
      ? [{ category: 'technical' as const, requirementIds: technical }]
      : []),
    ...(behavioural.length > 0
      ? [{ category: 'behavioural' as const, requirementIds: behavioural }]
      : []),
  ];
}

export async function closeCoverageGaps(args: {
  requirements: Requirement[];
  questions: Question[];
  generate: GapGenerator;
  maxPasses?: number;
}): Promise<CoverageLoopResult> {
  const maxPasses = args.maxPasses ?? MAX_COVERAGE_PASSES;
  const questions = [...args.questions];
  const rounds: RoundSummary[] = [];
  const limitations: string[] = [];

  let report = checkCoverage(args.requirements, questions);
  let passes = 1; // the draft has been checked
  let stoppedBecause: StopReason;

  for (;;) {
    if (args.requirements.length === 0) {
      stoppedBecause = 'no-requirements';
      break;
    }
    if (report.uncovered_must_ids.length === 0) {
      stoppedBecause =
        report.uncovered_requirement_ids.length === 0 ? 'covered' : 'only-nice-uncovered';
      break;
    }
    if (passes >= maxPasses) {
      stoppedBecause = 'budget';
      break;
    }

    // A must-have gap justifies a round; uncovered nice-to-haves ride along in the same calls.
    const targeted = report.uncovered_requirement_ids;
    const mustBefore = report.uncovered_must_ids.length;
    const existingPrompts = new Set(questions.map((q) => normalizeWords(q.prompt)));
    let added = 0;
    let failedGroups = 0;
    let lastFailure: LlmError | undefined;
    let succeededGroups = 0;
    let nextId = nextIdNumber(questions);

    for (const group of groupsFor(args.requirements, targeted)) {
      let drafts: DraftQuestion[];
      try {
        drafts = await args.generate(group);
      } catch (err) {
        if (err instanceof LlmError && !isFatalForRun(err)) {
          failedGroups++;
          lastFailure = err;
          continue;
        }
        throw err; // fatal for the run, or a bug: do not swallow it
      }
      succeededGroups++;
      for (const d of drafts) {
        const key = normalizeWords(d.prompt);
        if (existingPrompts.has(key)) continue;
        existingPrompts.add(key);
        questions.push({
          id: `q${nextId++}`,
          requirement_ids: d.requirement_ids,
          category: d.category,
          prompt: d.prompt,
          answer_outline: d.answer_outline,
          difficulty: d.difficulty,
        });
        added++;
      }
    }

    if (succeededGroups === 0) {
      // Nothing was generated, so there is nothing new to check.
      stoppedBecause = 'failed';
      limitations.push(
        `Gap filling stopped: the model could not be used (${lastFailure?.code ?? 'error'}).`,
      );
      break;
    }

    report = checkCoverage(args.requirements, questions);
    passes++;
    rounds.push({
      pass: passes,
      targeted: [...targeted],
      questionsAdded: added,
      stillUncovered: [...report.uncovered_requirement_ids],
      failedGroups,
    });

    if (failedGroups > 0) {
      stoppedBecause = 'failed';
      limitations.push(
        `Gap filling stopped early: part of the model calls failed (${lastFailure?.code ?? 'error'}).`,
      );
      break;
    }
    // Progress means the must-have gaps shrank. Covering only a nice-to-have does not count, so
    // a round like that does not earn another pass.
    if (report.uncovered_must_ids.length >= mustBefore) {
      stoppedBecause = 'no-progress';
      limitations.push(
        'Gap filling made no progress: the new questions did not cover any further must-have requirement.',
      );
      break;
    }
  }

  if (stoppedBecause === 'budget') {
    limitations.push(
      `${report.uncovered_must_ids.length} must-have requirement(s) are still not covered by any question after ${passes} coverage check${passes === 1 ? '' : 's'}: ${report.uncovered_must_ids.join(', ')}.`,
    );
  } else if (report.uncovered_must_ids.length > 0 && stoppedBecause !== 'no-requirements') {
    limitations.push(
      `Must-have requirement(s) still have no question: ${report.uncovered_must_ids.join(', ')}.`,
    );
  }
  if (report.uncovered_requirement_ids.length > report.uncovered_must_ids.length) {
    const nice = report.uncovered_requirement_ids.filter(
      (id) => !report.uncovered_must_ids.includes(id),
    );
    limitations.push(
      `${nice.length} nice-to-have requirement(s) have no question: ${nice.join(', ')}.`,
    );
  }

  return { questions, report, passes, rounds, stoppedBecause, limitations };
}
