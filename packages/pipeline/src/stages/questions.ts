import type { QuestionCategory, Requirement } from '@trao/contracts';
import type { LlmClient } from '../llm/client.js';
import { normalizeWords } from '../research/text-match.js';
import { systemPrompt, untrustedBlock } from './prompt.js';
import { questionsSchema } from './schemas.js';

const MAX_OUTPUT_TOKENS = 6000;
const MAX_IDS_PER_QUESTION = 4;
const MAX_MENTIONS = 5;
const MAX_DISCUSSION = 4;
const MIN_USABLE_TEXT = 40;

export interface DraftQuestion {
  category: QuestionCategory;
  requirement_ids: string[];
  prompt: string;
  answer_outline: string;
  difficulty: number;
}

export interface QuestionContext {
  role: { title: string; seniority: string };
  requirements: Requirement[];
  /** The brief's description of the company ('' if none). */
  whatTheyDo: string;
  /** Quoted passages from the company's own pages about how it interviews, with their URLs. */
  interviewMentions: { url: string; text: string }[];
  /** Unverified forum comments about interviewing there. */
  discussion: { url: string; snippet: string }[];
  hasCompanyEvidence: boolean;
}

export interface CategoryResult {
  category: QuestionCategory;
  questions: DraftQuestion[];
  /** Why no model call was made, when none was. */
  skipped?: string;
  dropped: { unknownRefs: number; outOfScopeRefs: number; withoutRefs: number; duplicates: number };
}

/** Which requirements a category may ask about and may claim to cover. Kept apart on purpose. */
export function eligibleRequirements(
  category: QuestionCategory,
  requirements: Requirement[],
): Requirement[] {
  switch (category) {
    case 'technical':
    case 'system-design':
      return requirements.filter((r) => r.kind === 'technical' || r.kind === 'domain');
    case 'behavioural':
      return requirements.filter((r) => r.kind === 'behavioural');
    case 'company-fit':
      return requirements;
  }
}

/** What question generation reads from research: page mentions and discussion snippets. */
export interface QuestionResearch {
  crawl: { pages: { url: string; text: string; interview_mentions: string[] }[] };
  discussion: { items: { url: string; snippet: string }[] };
}

export function buildQuestionContext(
  role: { title: string; seniority: string },
  requirements: Requirement[],
  research: QuestionResearch,
  whatTheyDo: string,
): QuestionContext {
  const interviewMentions = research.crawl.pages
    .flatMap((p) => p.interview_mentions.map((text) => ({ url: p.url, text })))
    .slice(0, MAX_MENTIONS);
  const discussion = research.discussion.items
    .slice(0, MAX_DISCUSSION)
    .map((i) => ({ url: i.url, snippet: i.snippet }));
  const hasPages = research.crawl.pages.some((p) => p.text.trim().length >= MIN_USABLE_TEXT);
  return {
    role,
    requirements,
    whatTheyDo,
    interviewMentions,
    discussion,
    hasCompanyEvidence: hasPages || research.discussion.items.length > 0,
  };
}

const ROLE_TEXT: Record<QuestionCategory, string> = {
  technical:
    'You write hands-on TECHNICAL interview questions: concrete skills, tools, debugging and depth of knowledge for the listed requirements.',
  behavioural:
    'You write BEHAVIOURAL interview questions (past experience, "tell me about a time…"): teamwork, mentoring, communication and ownership for the listed requirements.',
  'system-design':
    'You write SYSTEM DESIGN interview questions: open-ended architecture and trade-off problems that a candidate with the listed technical requirements should be able to discuss.',
  'company-fit':
    'You write COMPANY-FIT interview questions: why this company, how its product, domain and way of working relate to the candidate’s experience. Use only the supplied company evidence; never state facts about the company that it does not contain.',
};

function limits(category: QuestionCategory, eligibleCount: number, gap: boolean): { max: number } {
  if (gap) return { max: Math.min(8, Math.max(1, eligibleCount + 1)) };
  if (category === 'company-fit') return { max: 4 };
  return { max: Math.min(12, Math.max(3, eligibleCount + 2)) };
}

function buildPrompt(
  category: QuestionCategory,
  ctx: QuestionContext,
  eligible: Requirement[],
  gap: boolean,
  max: number,
): string {
  const lines: string[] = [];
  lines.push('Role:');
  lines.push(
    untrustedBlock(
      'role',
      `${ctx.role.title || 'unknown title'} | seniority: ${ctx.role.seniority || 'not stated'}`,
    ),
  );
  lines.push('');

  lines.push(
    gap
      ? 'These requirements currently have no question. Write questions ONLY for these (id | priority | kind | text):'
      : 'Requirements to cover (id | priority | kind | text):',
  );
  lines.push(
    untrustedBlock(
      'requirements',
      eligible.length > 0
        ? eligible.map((r) => `${r.id} | ${r.priority} | ${r.kind} | ${r.text}`).join('\n')
        : '(none listed)',
    ),
  );
  lines.push('');

  if (ctx.whatTheyDo.trim() !== '') {
    lines.push('What the company does (a summary of its own website):');
    lines.push(untrustedBlock('company', ctx.whatTheyDo));
    lines.push('');
  }

  if (ctx.interviewMentions.length > 0) {
    lines.push('How the company says it interviews (quoted from its own pages):');
    lines.push(
      untrustedBlock(
        'interview-mentions',
        ctx.interviewMentions.map((m) => `[${m.url}] ${m.text}`).join('\n'),
      ),
    );
    lines.push(
      'Match the interview stages described above: for example, if a take-home or a system design interview is mentioned, include questions in that style. Do not claim stages that are not listed.',
    );
  } else {
    lines.push('The company’s interview process is unknown. Do not assume one.');
  }
  lines.push('');

  if ((category === 'company-fit' || category === 'behavioural') && ctx.discussion.length > 0) {
    lines.push(
      'Unverified comments from Hacker News about interviewing at this company (may be wrong or outdated):',
    );
    lines.push(
      untrustedBlock(
        'forum-comments',
        ctx.discussion.map((d) => `[${d.url}] ${d.snippet}`).join('\n'),
      ),
    );
    lines.push('');
  }

  lines.push('Instructions:');
  if (category === 'company-fit') {
    lines.push(
      `- Write at most ${max} questions. A question may list requirement ids it touches, or none if it is only about the company.`,
    );
  } else {
    lines.push(
      `- Write at most ${max} questions, covering EVERY requirement listed above at least once.`,
    );
    lines.push(
      '- Put the ids of the requirements a question tests in requirement_ids (up to 3 per question).',
    );
  }
  lines.push(
    '- difficulty: 1 = easy, 2 = medium, 3 = hard. Calibrate to the seniority of the role.',
  );
  lines.push(
    '- answer_outline: 3 to 6 short "- " bullet points describing what a strong answer covers.',
  );
  lines.push('- Do not put requirement ids inside the question text. Do not repeat a question.');
  return lines.join('\n');
}

/**
 * Stage 3: questions for ONE category, in its own model call with its own role prompt and its
 * own requirement subset. Application code decides what is kept: ids must exist and belong to
 * this category's scope, a question with no valid id is dropped (except company-fit), duplicates
 * go, and the count is capped. A category with nothing to ask about makes no call at all.
 */
export async function generateCategoryQuestions(
  llm: LlmClient,
  category: QuestionCategory,
  ctx: QuestionContext,
  options: { targetIds?: string[] } = {},
): Promise<CategoryResult> {
  const dropped = { unknownRefs: 0, outOfScopeRefs: 0, withoutRefs: 0, duplicates: 0 };
  const skip = (reason: string): CategoryResult => ({
    category,
    questions: [],
    skipped: reason,
    dropped,
  });
  const gap = options.targetIds !== undefined;

  if (category === 'company-fit' && !ctx.hasCompanyEvidence)
    return skip('No company evidence was available.');

  let eligible = eligibleRequirements(category, ctx.requirements);
  if (gap) {
    const targets = new Set(options.targetIds);
    eligible = eligible.filter((r) => targets.has(r.id));
    if (eligible.length === 0)
      return skip(`None of the uncovered requirements belong to ${category}.`);
  } else if (eligible.length === 0 && category !== 'company-fit') {
    return skip(`There are no ${category} requirements to ask about.`);
  }

  const { max } = limits(category, eligible.length, gap);
  const out = await llm.generateObject({
    stage: `questions:${category}${gap ? ':gap' : ''}`,
    system: systemPrompt(`questions:${category}`, ROLE_TEXT[category]),
    prompt: buildPrompt(category, ctx, eligible, gap, max),
    schema: questionsSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  const known = new Set(ctx.requirements.map((r) => r.id));
  const inScope = new Set(eligible.map((r) => r.id));
  const seen = new Set<string>();
  const questions: DraftQuestion[] = [];

  for (const raw of out.questions) {
    const ids: string[] = [];
    for (const id of raw.requirement_ids) {
      if (!known.has(id)) dropped.unknownRefs++;
      else if (!inScope.has(id)) dropped.outOfScopeRefs++;
      else if (!ids.includes(id)) ids.push(id);
    }
    if (ids.length === 0 && category !== 'company-fit') {
      dropped.withoutRefs++;
      continue;
    }
    const key = normalizeWords(raw.prompt);
    if (seen.has(key)) {
      dropped.duplicates++;
      continue;
    }
    seen.add(key);
    questions.push({
      category,
      requirement_ids: ids.slice(0, MAX_IDS_PER_QUESTION),
      prompt: raw.prompt.trim(),
      answer_outline: raw.answer_outline.trim(),
      difficulty: raw.difficulty,
    });
    if (questions.length >= max) break;
  }

  return { category, questions, dropped };
}
