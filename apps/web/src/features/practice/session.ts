import type { Confidence } from '@trao/contracts';

/**
 * One practice session as a pure state machine. The cards are fixed when the session starts (the order
 * comes from the saved progress, see orderForPractice), and a rating is only counted once the server has
 * stored it: the session advances after a save, never before, so a card cannot be passed over with its
 * answer unrecorded. A failed save keeps the card, its answer and the chosen rating on screen.
 */

export interface SessionCard {
  id: string;
  front: string;
  back: string;
}

export interface Pending {
  confidence: Confidence;
  attemptId: string;
}

export type SessionStatus = 'asking' | 'saving' | 'save-failed' | 'done';

export interface SessionState {
  cards: SessionCard[];
  index: number;
  /** Whether the answer for the current card has been asked for. It is never shown before. */
  revealed: boolean;
  status: SessionStatus;
  pending: Pending | null;
  error: string | null;
  /** Ratings stored during this session, in the order they were made. */
  rated: { cardId: string; confidence: Confidence }[];
  /** Cards passed over without a rating; they stay uncovered. */
  skipped: string[];
}

export type SessionAction =
  | { type: 'reveal' }
  | { type: 'rate'; confidence: Confidence; attemptId: string }
  | { type: 'retry' }
  | { type: 'saved' }
  | { type: 'save-failed'; message: string }
  | { type: 'skip' };

export function startSession(cards: SessionCard[]): SessionState {
  return {
    cards,
    index: 0,
    revealed: false,
    status: cards.length === 0 ? 'done' : 'asking',
    pending: null,
    error: null,
    rated: [],
    skipped: [],
  };
}

export const currentCard = (s: SessionState): SessionCard | null => s.cards[s.index] ?? null;

function advance(s: SessionState, patch: Partial<SessionState>): SessionState {
  const next = s.index + 1;
  return {
    ...s,
    ...patch,
    index: next,
    revealed: false,
    pending: null,
    error: null,
    status: next >= s.cards.length ? 'done' : 'asking',
  };
}

export function sessionReducer(s: SessionState, action: SessionAction): SessionState {
  const card = currentCard(s);
  if (!card) return s;
  switch (action.type) {
    case 'reveal':
      return s.status === 'asking' && !s.revealed ? { ...s, revealed: true } : s;

    case 'rate':
      // Only after the answer was asked for, and not while a save is in progress (no double submit).
      if (!s.revealed || (s.status !== 'asking' && s.status !== 'save-failed')) return s;
      return {
        ...s,
        status: 'saving',
        error: null,
        pending: { confidence: action.confidence, attemptId: action.attemptId },
      };

    case 'retry':
      // The same attempt again: the server counts it once even if the first request did arrive.
      return s.status === 'save-failed' && s.pending ? { ...s, status: 'saving', error: null } : s;

    case 'saved':
      if (s.status !== 'saving' || !s.pending) return s;
      return advance(s, {
        rated: [...s.rated, { cardId: card.id, confidence: s.pending.confidence }],
      });

    case 'save-failed':
      return s.status === 'saving' ? { ...s, status: 'save-failed', error: action.message } : s;

    case 'skip':
      // Only before the answer was shown: once it has been seen, the card is rated, not skipped.
      return s.status === 'asking' && !s.revealed
        ? advance(s, { skipped: [...s.skipped, card.id] })
        : s;
  }
}
