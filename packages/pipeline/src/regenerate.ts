import type {
  Kit,
  RegenerationApply,
  RegenerationRequest,
  ResearchSnapshot,
} from '@trao/contracts';
import type { LlmClient } from './llm/client.js';
import { generateCompanyBrief, usablePages, type BriefResearch } from './stages/company-brief.js';
import {
  buildQuestionContext,
  eligibleRequirements,
  generateCategoryQuestions,
  type QuestionResearch,
} from './stages/questions.js';

/**
 * Section regeneration. Each supported section has its own source requirements, checked BEFORE any
 * model call, and each refusal names the section and the missing source. A source that one section
 * needs never blocks another: a kit with no stored research can still have its schedule or its
 * technical questions regenerated.
 *
 *   brief       needs the stored research: at least one page with readable text. The brief is only
 *               replaced with prose whose claims were verified against those stored pages.
 *   questions   needs the kit's own requirements for that category. Company-fit questions also need
 *               company evidence (stored pages with text, or discussion snippets); the other
 *               categories use stored interview evidence when there is some and run without it
 *               when there is none, saying nothing about an interview process they cannot know.
 *   schedule    needs nothing but the current kit: it is arithmetic, with no model call.
 *
 * This module only produces the material (`RegenerationApply`). What the kit keeps, drops and where
 * things go is decided by `applyRegeneration` in `@trao/core`, and persistence by the API.
 */

export const REGENERATION_REFUSAL_CODES = [
  'RESEARCH_UNAVAILABLE',
  'NO_USABLE_PAGES',
  'NO_COMPANY_EVIDENCE',
  'NO_REQUIREMENTS_FOR_CATEGORY',
  'BRIEF_NOT_VERIFIED',
  'NOTHING_TO_GENERATE',
  'NO_QUESTIONS_GENERATED',
] as const;
export type RegenerationRefusalCode = (typeof REGENERATION_REFUSAL_CODES)[number];

/** A request that cannot be carried out, with a reason that is safe to show. Nothing was changed. */
export class RegenerationRefusal extends Error {
  constructor(
    readonly code: RegenerationRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'RegenerationRefusal';
  }
}

type KitPart = Pick<Kit, 'role' | 'company_brief'>;
type Available = Extract<ResearchSnapshot, { status: 'available' }>;

const MIN_USABLE_TEXT = 40;

/** The stored evidence in the shapes the generation stages read. Unavailable research is "no evidence". */
function evidence(research: ResearchSnapshot): BriefResearch & QuestionResearch {
  if (research.status !== 'available') {
    return {
      company: { name: null },
      crawl: { status: 'unreachable', pages: [] },
      discussion: { items: [] },
    };
  }
  return {
    company: { name: research.company_name },
    crawl: { status: research.crawl_status, pages: research.pages },
    discussion: { items: research.discussion.items },
  };
}

function hasUsablePages(research: Available): boolean {
  return research.pages.some((p) => p.text.trim().length >= MIN_USABLE_TEXT);
}

/**
 * Whether the requested section can be regenerated from what is stored. Returns the reason if not.
 * Pure and cheap, so the API can answer immediately and the job can check again when it starts.
 */
export function checkRegenerationSources(
  request: RegenerationRequest,
  kit: KitPart,
  research: ResearchSnapshot,
): { ok: true } | { ok: false; code: RegenerationRefusalCode; message: string } {
  const refuse = (code: RegenerationRefusalCode, message: string) => ({
    ok: false as const,
    code,
    message,
  });

  switch (request.section) {
    case 'schedule':
      return { ok: true };

    case 'brief':
      if (research.status !== 'available') {
        return refuse(
          'RESEARCH_UNAVAILABLE',
          'The company brief cannot be regenerated: the research this kit was built from was not kept. Kits created before research was stored have none, and it is not reconstructed.',
        );
      }
      if (!hasUsablePages(research)) {
        return refuse(
          'NO_USABLE_PAGES',
          'The company brief cannot be regenerated: none of the stored company pages has readable text.',
        );
      }
      return { ok: true };

    case 'questions': {
      const category = request.category;
      if (category === 'company-fit') {
        const stored = research.status === 'available';
        const hasEvidence =
          research.status === 'available' &&
          (hasUsablePages(research) || research.discussion.items.length > 0);
        if (!hasEvidence) {
          return refuse(
            stored ? 'NO_COMPANY_EVIDENCE' : 'RESEARCH_UNAVAILABLE',
            stored
              ? 'Company-fit questions cannot be regenerated: the stored research has no readable company page or discussion to base them on.'
              : 'Company-fit questions cannot be regenerated: they are built from company research, and the research this kit was built from was not kept.',
          );
        }
        return { ok: true };
      }
      if (eligibleRequirements(category, kit.role.requirements).length === 0) {
        return refuse(
          'NO_REQUIREMENTS_FOR_CATEGORY',
          `${category} questions cannot be regenerated: this kit has no ${category === 'behavioural' ? 'behavioural' : 'technical or domain'} requirements to ask about.`,
        );
      }
      return { ok: true };
    }
  }
}

/**
 * Produces the regenerated material for one section. Throws RegenerationRefusal when the sources are
 * missing or the model's answer cannot be used (in which case nothing should be changed), and lets
 * model-layer errors (LlmError) through for the caller to map.
 */
export async function generateRegeneration(
  request: RegenerationRequest,
  kit: KitPart,
  research: ResearchSnapshot,
  deps: { llm: LlmClient },
): Promise<RegenerationApply> {
  const check = checkRegenerationSources(request, kit, research);
  if (!check.ok) throw new RegenerationRefusal(check.code, check.message);

  const stored = evidence(research);

  switch (request.section) {
    case 'schedule':
      return { section: 'schedule' };

    case 'brief': {
      const result = await generateCompanyBrief(deps.llm, stored);
      // The prose is only trusted when claims in it were verified against the stored pages. Otherwise
      // the existing brief stays: a worse brief is not an improvement.
      if (result.provenance !== 'model-summary' || usablePages(stored).length === 0) {
        throw new RegenerationRefusal(
          'BRIEF_NOT_VERIFIED',
          'A new brief could not be verified against the stored pages, so the existing brief was kept.',
        );
      }
      return { section: 'brief', brief: result.brief };
    }

    case 'questions': {
      const context = buildQuestionContext(
        { title: kit.role.title, seniority: kit.role.seniority },
        kit.role.requirements,
        stored,
        kit.company_brief.what_they_do,
      );
      const result = await generateCategoryQuestions(deps.llm, request.category, context);
      if (result.skipped) throw new RegenerationRefusal('NOTHING_TO_GENERATE', result.skipped);
      if (result.questions.length === 0) {
        throw new RegenerationRefusal(
          'NO_QUESTIONS_GENERATED',
          'The model produced no usable questions, so the existing questions were kept.',
        );
      }
      return {
        section: 'questions',
        category: request.category,
        questions: result.questions.map((q) => ({
          prompt: q.prompt,
          answer_outline: q.answer_outline,
          difficulty: q.difficulty,
          requirement_ids: q.requirement_ids,
        })),
      };
    }
  }
}
