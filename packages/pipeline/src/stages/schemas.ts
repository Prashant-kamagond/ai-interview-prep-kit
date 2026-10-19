import { z } from 'zod';
import { QUESTION_CATEGORIES, REQUIREMENT_KINDS, REQUIREMENT_PRIORITIES } from '@trao/contracts';

/**
 * What the model is asked to return, per stage. These are the model-facing shapes: the kit's own
 * Appendix A schema (in @trao/contracts) is untouched and remains the source of truth for the
 * final result. The model never supplies ids; application code assigns them.
 *
 * Every schema must stay inside the JSON Schema subset Gemini accepts (see llm/json-schema.ts,
 * which refuses anything else), and every value is re-validated by the stage that uses it.
 */

export const MAX_REQUIREMENTS = 40;
export const MAX_RESPONSIBILITIES = 15;
export const MAX_QUESTIONS_PER_CALL = 14;
export const MAX_FLASHCARDS = 24;
export const MAX_CLAIMS = 12;

export const extractionSchema = z.object({
  title: z.string().max(200),
  seniority: z.string().max(100),
  location: z.string().max(200),
  company: z.string().max(200),
  responsibilities: z
    .array(z.object({ text: z.string().min(1).max(300), quote: z.string().min(1).max(500) }))
    .max(MAX_RESPONSIBILITIES),
  requirements: z
    .array(
      z.object({
        text: z.string().min(1).max(300),
        quote: z.string().min(1).max(500),
        kind: z.enum(REQUIREMENT_KINDS),
        priority: z.enum(REQUIREMENT_PRIORITIES),
      }),
    )
    .max(MAX_REQUIREMENTS),
});
export type ExtractionOutput = z.infer<typeof extractionSchema>;

export const briefSchema = z.object({
  what_they_do: z.string().max(800),
  summary: z.string().max(1500),
  claims: z
    .array(
      z.object({
        text: z.string().min(1).max(400),
        quote: z.string().min(1).max(500),
        source_url: z.string().min(1).max(2048),
      }),
    )
    .max(MAX_CLAIMS),
});
export type BriefOutput = z.infer<typeof briefSchema>;

export const questionsSchema = z.object({
  questions: z
    .array(
      z.object({
        requirement_ids: z.array(z.string().max(20)).max(8),
        prompt: z.string().min(1).max(600),
        answer_outline: z.string().min(1).max(2000),
        difficulty: z.number().int().min(1).max(3),
      }),
    )
    .max(MAX_QUESTIONS_PER_CALL),
});
export type QuestionsOutput = z.infer<typeof questionsSchema>;

export const flashcardsSchema = z.object({
  flashcards: z
    .array(
      z.object({
        front: z.string().min(1).max(300),
        back: z.string().min(1).max(800),
        requirement_ids: z.array(z.string().max(20)).max(8),
      }),
    )
    .max(MAX_FLASHCARDS),
});
export type FlashcardsOutput = z.infer<typeof flashcardsSchema>;

export { QUESTION_CATEGORIES };
