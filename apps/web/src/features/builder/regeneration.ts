import {
  type QuestionCategory,
  type RegenerationReport,
  type RegenerationRequest,
  type Requirement,
  type ResearchSnapshot,
} from '@trao/contracts';
import { CATEGORY_LABELS } from '../kit/view';

type Skip = RegenerationReport['skipped'][number]['reason'];

/** Names the section in a sentence ("the company brief", "the technical questions", "the schedule"). */
export function sectionName(request: RegenerationRequest): string {
  switch (request.section) {
    case 'brief':
      return 'the company brief';
    case 'schedule':
      return 'the schedule';
    case 'questions':
      return `the ${CATEGORY_LABELS[request.category].toLowerCase()} questions`;
  }
}

export const NO_RESEARCH_REASON =
  'The research this kit was built from was not kept. Kits created before research was stored have none, and it is never reconstructed.';

export interface SourceNote {
  /** What this section is regenerated from, in words. */
  needs: string;
  /** False when the data this device already holds shows the section cannot be regenerated. */
  available: boolean;
  /** Why not, when it is not available. The server's own answer is still the final word. */
  reason?: string;
}

/** Whether the kit has requirements the category can ask about (the same rule the server applies). */
export function categoryHasRequirements(
  category: QuestionCategory,
  requirements: readonly Requirement[],
): boolean {
  switch (category) {
    case 'company-fit':
      return true;
    case 'behavioural':
      return requirements.some((r) => r.kind === 'behavioural');
    default:
      return requirements.some((r) => r.kind === 'technical' || r.kind === 'domain');
  }
}

/**
 * What each regeneration needs, shown before anything is submitted, and whether the kit already
 * rules it out. This only reads data the editor holds; it never decides for the server, which checks
 * again and may refuse for a reason the editor cannot see (for example stored pages without text).
 */
export function sourceNote(
  request: RegenerationRequest,
  research: ResearchSnapshot,
  requirements: readonly Requirement[],
): SourceNote {
  const stored = research.status === 'available';
  switch (request.section) {
    case 'schedule':
      return { needs: 'Needs only the current kit. No model is used.', available: true };
    case 'brief':
      return {
        needs:
          'Needs the company research stored with this kit: at least one page with readable text.',
        available: stored,
        ...(stored ? {} : { reason: NO_RESEARCH_REASON }),
      };
    case 'questions': {
      if (request.category === 'company-fit') {
        return {
          needs:
            'Needs the company research stored with this kit: a readable page or public discussion.',
          available: stored,
          ...(stored ? {} : { reason: NO_RESEARCH_REASON }),
        };
      }
      const has = categoryHasRequirements(request.category, requirements);
      return {
        needs:
          'Uses this kit’s requirements for the category. Stored company research is used when there is some; it is not required.',
        available: has,
        ...(has
          ? {}
          : {
              reason: `This kit has no ${request.category === 'behavioural' ? 'behavioural' : 'technical or domain'} requirements to ask about.`,
            }),
      };
    }
  }
}

const SKIP_TEXT: Record<Skip, string> = {
  pinned: 'Pinned, so kept',
  edited: 'Edited by you, so kept',
  on_pinned_day: 'On a pinned day, so kept',
  tombstone: 'Deleted earlier, so not brought back',
  duplicate: 'Repeats something already in the kit',
  unknown_requirement: 'Refers to a requirement that does not exist',
  no_schedulable_day: 'Every day is pinned, so it could not be scheduled',
};

export const describeSkip = (reason: Skip): string => SKIP_TEXT[reason];

/** One sentence summarising a report, for announcing and for the top of the report. */
export function summarizeReport(report: RegenerationReport): string {
  const parts: string[] = [];
  if (report.section === 'schedule') {
    const days = report.days;
    parts.push(
      days && days.reallocated.length > 0
        ? `${days.reallocated.length} ${days.reallocated.length === 1 ? 'day was' : 'days were'} re-planned`
        : 'No day was re-planned',
    );
    if (days && days.kept.length > 0)
      parts.push(
        `${days.kept.length} pinned ${days.kept.length === 1 ? 'day was' : 'days were'} kept`,
      );
  } else {
    parts.push(`${report.replaced.length} replaced`);
    parts.push(`${report.added.length} added`);
    parts.push(`${report.kept.length} kept`);
    if (report.skipped.length > 0) parts.push(`${report.skipped.length} skipped`);
  }
  return `${parts.join(', ')}.`;
}
