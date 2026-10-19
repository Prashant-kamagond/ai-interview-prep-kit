import type { QuestionCategory, Requirement } from '@trao/contracts';
import type { LlmClient } from '../llm/client.js';
import { normalizeWords } from '../research/text-match.js';
import { clip, systemPrompt, untrustedBlock } from './prompt.js';
import { MAX_FLASHCARDS, flashcardsSchema } from './schemas.js';

const MAX_OUTPUT_TOKENS = 5000;
const MAX_QUESTION_CHARS = 160;
const MAX_IDS_PER_CARD = 3;

export interface DraftFlashcard {
  front: string;
  back: string;
  requirement_ids: string[];
}

export interface FlashcardInput {
  role: { title: string; seniority: string };
  requirements: Requirement[];
  questions: {
    id: string;
    category: QuestionCategory;
    prompt: string;
    requirement_ids: string[];
  }[];
}

export interface FlashcardResult {
  flashcards: DraftFlashcard[];
  skipped?: string;
  dropped: { unknownRefs: number; withoutRefs: number; duplicates: number };
}

const ROLE = [
  'You write FLASHCARDS for revising before an interview: short recall prompts, one idea each.',
  'front: a short question or term. back: a concise answer of at most three sentences.',
  'Base every card on the requirements and questions provided; add no new topics.',
].join('\n');

/**
 * Stage 5: flashcards, one model call over the final requirements and questions. Application
 * code keeps a card only if it references at least one real requirement id; unknown ids are
 * removed, duplicates and surplus cards are dropped. Ids are assigned by the caller.
 */
export async function generateFlashcards(
  llm: LlmClient,
  input: FlashcardInput,
): Promise<FlashcardResult> {
  const dropped = { unknownRefs: 0, withoutRefs: 0, duplicates: 0 };
  if (input.requirements.length === 0 && input.questions.length === 0) {
    return { flashcards: [], skipped: 'There was nothing to base flashcards on.', dropped };
  }

  const max = Math.min(MAX_FLASHCARDS, Math.max(4, input.requirements.length * 2));
  const requirementList =
    input.requirements.map((r) => `${r.id} | ${r.priority} | ${r.kind} | ${r.text}`).join('\n') ||
    '(none listed)';
  const questionList =
    input.questions
      .map(
        (q) =>
          `${q.id} | ${q.category} | ${clip(q.prompt, MAX_QUESTION_CHARS).text} | covers: ${q.requirement_ids.join(', ')}`,
      )
      .join('\n') || '(none)';

  const out = await llm.generateObject({
    stage: 'flashcards',
    system: systemPrompt('flashcards', ROLE),
    prompt: [
      `Role: ${input.role.title ? 'see below' : 'unknown title'}`,
      untrustedBlock(
        'role',
        `${input.role.title || 'unknown title'} | seniority: ${input.role.seniority || 'not stated'}`,
      ),
      '',
      'Requirements (id | priority | kind | text):',
      untrustedBlock('requirements', requirementList),
      '',
      'Interview questions already written (id | category | question | requirement ids):',
      untrustedBlock('questions', questionList),
      '',
      'Instructions:',
      `- Write at most ${max} flashcards. Cover every must-have requirement at least once.`,
      '- Put the ids of the requirements a card revises in requirement_ids (up to 3). Use only ids listed above.',
      '- Do not repeat a card.',
    ].join('\n'),
    schema: flashcardsSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  const known = new Set(input.requirements.map((r) => r.id));
  const seen = new Set<string>();
  const flashcards: DraftFlashcard[] = [];
  for (const raw of out.flashcards) {
    const ids: string[] = [];
    for (const id of raw.requirement_ids) {
      if (!known.has(id)) dropped.unknownRefs++;
      else if (!ids.includes(id)) ids.push(id);
    }
    if (ids.length === 0) {
      dropped.withoutRefs++;
      continue;
    }
    const key = normalizeWords(raw.front);
    if (seen.has(key)) {
      dropped.duplicates++;
      continue;
    }
    seen.add(key);
    flashcards.push({
      front: raw.front.trim(),
      back: raw.back.trim(),
      requirement_ids: ids.slice(0, MAX_IDS_PER_CARD),
    });
    if (flashcards.length >= max) break;
  }
  return { flashcards, dropped };
}
