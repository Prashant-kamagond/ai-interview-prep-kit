import { z } from 'zod';

/**
 * Practice mode (assignment section 7). The user steps through a kit's flashcards, records how
 * confident they felt on each card, and the next session is ordered by what they were least confident
 * about. What is stored is only that: one record per card the user has rated.
 *
 * The assignment names no scale, so this one is chosen and defended in docs/practice.md: three levels, a
 * higher number means more confident.
 *   1  not confident (did not know it)
 *   2  somewhat confident (partly knew it)
 *   3  confident (knew it)
 */
export const CONFIDENCE_LEVELS = [1, 2, 3] as const;
export const confidenceSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

/**
 * Sent when a card is rated. `attempt_id` is made by the browser for one press of a rating button, so a
 * request that is sent twice (a retry after a lost response, a double click) is recorded once.
 */
export const practiceAttemptRequestSchema = z.object({
  confidence: confidenceSchema,
  attempt_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/, 'attempt_id must be 8-64 letters, digits, - or _'),
});

/** What is known about one card: the latest rating, how many times it was rated, and when. */
export const cardProgressSchema = z.object({
  card_id: z.string().min(1).max(64),
  confidence: confidenceSchema,
  attempts: z.number().int().min(1),
  last_practised_at: z.string(),
});

export const practiceProgressResponseSchema = z.object({
  kit_id: z.string().min(1),
  /** Only cards that still exist in the kit; a card the user deleted is never reported. */
  cards: z.array(cardProgressSchema),
});

export type Confidence = z.infer<typeof confidenceSchema>;
export type PracticeAttemptRequest = z.infer<typeof practiceAttemptRequestSchema>;
export type CardProgress = z.infer<typeof cardProgressSchema>;
export type PracticeProgressResponse = z.infer<typeof practiceProgressResponseSchema>;
