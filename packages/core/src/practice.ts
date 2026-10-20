import type { CardProgress, Confidence } from '@trao/contracts';

/**
 * Practice mode logic. Pure and deterministic, like the rest of the core.
 *
 * Ordering rule (the assignment asks for "the next session ordered by what they were least confident
 * about" and lets us pick; this is a confidence-weighted sort, not spaced repetition):
 *
 *   1. cards never rated come first. Nothing is known about them, which is less than "not confident",
 *      and they are also the cards not yet covered;
 *   2. then by the LATEST confidence, lowest first (1, then 2, then 3). The latest rating is used rather
 *      than an average because it reflects what the user knows now: a card they finally got right stops
 *      coming first;
 *   3. within the same confidence, the card practised longest ago first;
 *   4. otherwise the kit's own order, so the result is stable and repeatable.
 *
 * Every flashcard is included: the order says what to do first, and the user decides when to stop.
 * Progress for a card that is not in the kit (deleted) is ignored.
 */

export interface PracticeCard {
  id: string;
}

export function orderForPractice<T extends PracticeCard>(
  flashcards: readonly T[],
  progress: readonly Pick<CardProgress, 'card_id' | 'confidence' | 'last_practised_at'>[],
): T[] {
  const byCard = new Map(progress.map((p) => [p.card_id, p]));
  const keyed = flashcards.map((card, index) => {
    const known = byCard.get(card.id);
    const time = known ? Date.parse(known.last_practised_at) : Number.NEGATIVE_INFINITY;
    return {
      card,
      index,
      level: known ? known.confidence : 0,
      // an unreadable date sorts as the oldest, so it is practised sooner rather than later
      time: Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time,
    };
  });
  keyed.sort(
    (a, b) =>
      a.level - b.level || (a.time === b.time ? 0 : a.time < b.time ? -1 : 1) || a.index - b.index,
  );
  return keyed.map((k) => k.card);
}

export interface PracticeSummary {
  total: number;
  /** Cards that have been rated at least once, ever. */
  covered: number;
  /** Ids of the cards never rated, in kit order. */
  uncovered_ids: string[];
  /** Cards by their latest rating. */
  by_confidence: Record<Confidence, number>;
}

/**
 * What has been covered and what has not. A card is covered once it has been rated, and is counted by
 * its latest rating. Progress for cards not in the kit is ignored, so the numbers always add up.
 */
export function summarizePractice(
  flashcards: readonly PracticeCard[],
  progress: readonly Pick<CardProgress, 'card_id' | 'confidence'>[],
): PracticeSummary {
  const byCard = new Map(progress.map((p) => [p.card_id, p.confidence]));
  const by_confidence: Record<Confidence, number> = { 1: 0, 2: 0, 3: 0 };
  const uncovered_ids: string[] = [];
  let covered = 0;
  const seen = new Set<string>();
  for (const card of flashcards) {
    if (seen.has(card.id)) continue; // a duplicate id is a validation error elsewhere; count it once
    seen.add(card.id);
    const level = byCard.get(card.id);
    if (level === undefined) uncovered_ids.push(card.id);
    else {
      covered += 1;
      by_confidence[level] += 1;
    }
  }
  return { total: seen.size, covered, uncovered_ids, by_confidence };
}
