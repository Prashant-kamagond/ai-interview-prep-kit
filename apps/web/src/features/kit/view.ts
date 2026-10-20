import {
  QUESTION_CATEGORIES,
  type Flashcard,
  type Kit,
  type Question,
  type QuestionCategory,
  type Requirement,
} from '@trao/contracts';

/** A reference to a requirement. `requirement` is null when the id matches nothing in the kit. */
export interface RequirementRef {
  id: string;
  requirement: Requirement | null;
}

export interface QuestionView {
  question: Question;
  references: RequirementRef[];
}

export interface FlashcardView {
  flashcard: Flashcard;
  references: RequirementRef[];
}

export interface DayQuestion {
  id: string;
  /** Null when the schedule names a question the kit does not contain. */
  question: Question | null;
}

export interface DayView {
  day: number;
  focus: string;
  minutes: number;
  questions: DayQuestion[];
}

export interface KitView {
  mustHave: Requirement[];
  niceToHave: Requirement[];
  groups: { category: QuestionCategory; label: string; questions: QuestionView[] }[];
  flashcards: FlashcardView[];
  days: DayView[];
  uncovered: RequirementRef[];
  /** Requirements the kit does not list as uncovered. */
  coveredCount: number;
  totalMinutes: number;
}

export const CATEGORY_LABELS: Record<QuestionCategory, string> = {
  technical: 'Technical',
  behavioural: 'Behavioural',
  'system-design': 'System design',
  'company-fit': 'Company fit',
};

/**
 * Arranges a kit for reading. It only regroups and resolves ids; it never adds content, and it takes
 * the coverage result as the kit states it (it does not recompute which requirements are covered).
 */
export function buildKitView(kit: Kit): KitView {
  const requirements = new Map(kit.role.requirements.map((r) => [r.id, r]));
  const questions = new Map(kit.questions.map((q) => [q.id, q]));
  const refs = (ids: readonly string[]): RequirementRef[] =>
    ids.map((id) => ({ id, requirement: requirements.get(id) ?? null }));

  const groups = QUESTION_CATEGORIES.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    questions: kit.questions
      .filter((q) => q.category === category)
      .map((question) => ({ question, references: refs(question.requirement_ids) })),
  })).filter((g) => g.questions.length > 0);

  const days = [...kit.schedule.days]
    .sort((a, b) => a.day - b.day)
    .map((d) => ({
      day: d.day,
      focus: d.focus,
      minutes: d.minutes,
      questions: d.question_ids.map((id) => ({ id, question: questions.get(id) ?? null })),
    }));

  const uncoveredIds = new Set(kit.coverage.uncovered_requirement_ids);
  return {
    mustHave: kit.role.requirements.filter((r) => r.priority === 'must'),
    niceToHave: kit.role.requirements.filter((r) => r.priority === 'nice'),
    groups,
    flashcards: kit.flashcards.map((flashcard) => ({
      flashcard,
      references: refs(flashcard.requirement_ids),
    })),
    days,
    uncovered: refs(kit.coverage.uncovered_requirement_ids),
    coveredCount: kit.role.requirements.filter((r) => !uncoveredIds.has(r.id)).length,
    totalMinutes: kit.schedule.days.reduce((sum, d) => sum + d.minutes, 0),
  };
}

/** The address if the text is a web (http or https) address, otherwise null. Never anything else. */
export function webHref(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
