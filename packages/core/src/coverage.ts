import type { Coverage, Question, Requirement } from '@trao/contracts';

/**
 * Deterministic requirement-to-question coverage checking (assignment §3/§4).
 *
 * A requirement is covered when at least one question lists its id in `requirement_ids`. This is
 * pure set arithmetic: no model is consulted, and the same input always gives the same output.
 *
 * Orchestration is deliberately NOT here. The Phase 5 gap-filling loop lives in `packages/pipeline`
 * and uses this function as its only source of truth:
 *
 *   1. generate the first draft of questions                      (pass 1 = this draft is checked)
 *   2. report = checkCoverage(requirements, questions)
 *   3. if report.uncovered_requirement_ids is empty → stop
 *   4. otherwise generate questions for exactly those ids, append them, run another pass
 *   5. stop when nothing is uncovered or the pass budget is spent, then
 *      coverage = buildCoverage(report, passesRun)
 *
 * Whatever is still uncovered after the budget is kept in `coverage.uncovered_requirement_ids` so
 * the gap is visible rather than silently dropped. The pass budget is a pipeline decision.
 */

export interface UnknownReference {
  question_id: string;
  requirement_id: string;
}

export interface CoverageReport {
  /** Requirements with at least one question, in requirement order. */
  covered_requirement_ids: string[];
  /** Requirements with no question, in requirement order. */
  uncovered_requirement_ids: string[];
  /** The subset of uncovered requirements whose priority is `must`. */
  uncovered_must_ids: string[];
  /** Question references to requirement ids that do not exist. They never count as coverage. */
  unknown_references: UnknownReference[];
}

export function checkCoverage(
  requirements: readonly Requirement[],
  questions: readonly Question[],
): CoverageReport {
  const known = new Set(requirements.map((r) => r.id));
  const referenced = new Set<string>();
  const unknown_references: UnknownReference[] = [];

  for (const q of questions) {
    for (const id of q.requirement_ids) {
      if (known.has(id)) referenced.add(id);
      else unknown_references.push({ question_id: q.id, requirement_id: id });
    }
  }

  const covered_requirement_ids: string[] = [];
  const uncovered_requirement_ids: string[] = [];
  const uncovered_must_ids: string[] = [];
  const seen = new Set<string>();

  for (const r of requirements) {
    if (seen.has(r.id)) continue; // duplicate ids are a validation error; list each id once here
    seen.add(r.id);
    if (referenced.has(r.id)) {
      covered_requirement_ids.push(r.id);
    } else {
      uncovered_requirement_ids.push(r.id);
      if (r.priority === 'must') uncovered_must_ids.push(r.id);
    }
  }

  return {
    covered_requirement_ids,
    uncovered_requirement_ids,
    uncovered_must_ids,
    unknown_references,
  };
}

/** Maps a report plus the number of passes run onto the Appendix A `coverage` object. */
export function buildCoverage(report: CoverageReport, passes: number): Coverage {
  return { uncovered_requirement_ids: [...report.uncovered_requirement_ids], passes };
}
