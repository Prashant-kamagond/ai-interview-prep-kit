'use client';

import { useEffect, useReducer, useRef, useState, type RefObject } from 'react';
import type { CardProgress, Confidence } from '@trao/contracts';
import { summarizePractice } from '@trao/core';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { LinkButton } from '../../components/ui/LinkButton';
import { ApiError } from '../../lib/api/client';
import type { PracticeApi } from '../../lib/api/practice';
import { WRAP } from '../kit/KitDocument';
import {
  currentCard,
  sessionReducer,
  startSession,
  type SessionCard,
  type SessionState,
} from './session';

export const CONFIDENCE_CHOICES: { value: Confidence; label: string; hint: string }[] = [
  { value: 1, label: 'Not confident', hint: 'I did not know it' },
  { value: 2, label: 'Somewhat confident', hint: 'I knew part of it' },
  { value: 3, label: 'Confident', hint: 'I knew it' },
];

export function labelFor(confidence: Confidence): string {
  return CONFIDENCE_CHOICES.find((c) => c.value === confidence)!.label;
}

/** A fresh id for one press of a rating button (the server counts a repeated id once). */
export function newAttemptId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `a${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}

function describeSaveError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401)
      return 'Your session ended. Sign in again; this rating was not saved.';
    if (error.status === 404)
      return 'This card or kit no longer exists, so the rating was not saved.';
    if (error.status === 0 || error.status === 429) return error.message;
  }
  return 'The rating could not be saved. Please try again.';
}

export interface PracticeSessionProps {
  kitId: string;
  cards: SessionCard[];
  /** Everything saved before this session, for the coverage summary at the end. */
  progress: CardProgress[];
  api: Pick<PracticeApi, 'record'>;
  makeAttemptId?: () => string;
  /** Called with the stored record each time a rating is saved. */
  onRecorded: (card: CardProgress) => void;
  onAgain: () => void;
  onReset: () => Promise<boolean>;
}

/**
 * One card at a time. The answer is not in the page until it is asked for; a rating is saved before the
 * session moves on (and a failed save keeps the card, its answer and the choice on screen, with a retry
 * that the server counts once); a card can be skipped, in which case it stays uncovered.
 */
export function PracticeSession({
  kitId,
  cards,
  progress,
  api,
  makeAttemptId = newAttemptId,
  onRecorded,
  onAgain,
  onReset,
}: PracticeSessionProps) {
  const [state, dispatch] = useReducer(sessionReducer, cards, startSession);
  const card = currentCard(state);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const answerRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);
  const [announce, setAnnounce] = useState('');
  const sent = useRef<string | null>(null);

  // Save the pending rating, once per attempt (a re-render or a strict-mode replay does not resend it).
  const attemptId = state.pending?.attemptId ?? null;
  useEffect(() => {
    if (state.status !== 'saving' || !state.pending || !card) return;
    const key = `${state.pending.attemptId}`;
    if (sent.current === key) return;
    sent.current = key;
    const { confidence, attemptId: id } = state.pending;
    void api.record(kitId, card.id, { confidence, attemptId: id }).then(
      (stored) => {
        onRecorded(stored);
        setAnnounce(`Saved: ${labelFor(confidence)}.`);
        dispatch({ type: 'saved' });
      },
      (error: unknown) => dispatch({ type: 'save-failed', message: describeSaveError(error) }),
    );
    // a retry reuses the attempt id, so it must be allowed to send again
  }, [state.status, attemptId, state.pending, card, api, kitId, onRecorded]);

  // A retry of the SAME attempt after a failure may send again.
  useEffect(() => {
    if (state.status === 'save-failed') sent.current = null;
  }, [state.status]);

  // Focus follows the session: the question, then the answer, then the question of the next card.
  useEffect(() => {
    if (state.status === 'done') doneRef.current?.focus();
    else if (state.revealed) answerRef.current?.focus();
    else headingRef.current?.focus();
  }, [state.index, state.revealed, state.status]);

  useEffect(() => {
    if (state.status === 'done') {
      setAnnounce('Session complete.');
    } else if (card && !state.revealed) {
      setAnnounce(`Card ${state.index + 1} of ${state.cards.length}.`);
    } else if (card && state.revealed) {
      setAnnounce('Answer shown. Choose how confident you felt.');
    }
  }, [state.index, state.revealed, state.status, card, state.cards.length]);

  if (state.status === 'done' || !card) {
    return (
      <Done
        kitId={kitId}
        total={state.cards.length}
        state={state}
        progress={progress}
        headingRef={doneRef}
        announce={announce}
        onAgain={onAgain}
        onReset={onReset}
      />
    );
  }

  const saving = state.status === 'saving';
  const failed = state.status === 'save-failed';
  const position = state.index + 1;
  return (
    <section aria-label="Practice session" className="space-y-4">
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
      <div className="space-y-1">
        <p className="text-sm text-slate-700" aria-hidden="true">
          Card {position} of {state.cards.length} · {state.rated.length} rated this session
        </p>
        <progress
          className="h-2 w-full"
          max={state.cards.length}
          value={state.index}
          aria-label={`Session progress: ${state.index} of ${state.cards.length} cards done`}
        />
      </div>

      <div className="space-y-4 rounded-lg border border-slate-300 bg-white p-5">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className={`text-lg font-semibold text-slate-900 ${WRAP}`}
        >
          {card.front}
        </h2>

        {state.revealed ? (
          <div
            ref={answerRef}
            tabIndex={-1}
            role="region"
            aria-label="Answer"
            className={`whitespace-pre-line rounded-md bg-slate-50 p-3 text-slate-900 ${WRAP}`}
          >
            {card.back.trim() === '' ? 'This card has no answer written.' : card.back}
          </div>
        ) : (
          <Button onClick={() => dispatch({ type: 'reveal' })}>Show answer</Button>
        )}

        {state.revealed ? (
          <fieldset className="space-y-2" disabled={saving}>
            <legend className="text-sm font-medium text-slate-800">
              How confident did you feel?
            </legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {CONFIDENCE_CHOICES.map((c) => (
                <Button
                  key={c.value}
                  variant="secondary"
                  className="h-auto flex-col items-start py-2 text-left"
                  loading={saving && state.pending?.confidence === c.value}
                  onClick={() =>
                    dispatch({ type: 'rate', confidence: c.value, attemptId: makeAttemptId() })
                  }
                >
                  <span>{c.label}</span>
                  <span className="text-xs font-normal text-slate-600">{c.hint}</span>
                </Button>
              ))}
            </div>
          </fieldset>
        ) : null}

        {failed ? (
          <Alert
            tone="error"
            title="That rating was not saved"
            action={<Button onClick={() => dispatch({ type: 'retry' })}>Try saving again</Button>}
          >
            {state.error} You are still on this card; nothing was lost.
          </Alert>
        ) : null}
      </div>

      {!state.revealed ? (
        <Button variant="secondary" onClick={() => dispatch({ type: 'skip' })}>
          Skip this card for now
        </Button>
      ) : null}
    </section>
  );
}

function Done({
  kitId,
  total,
  state,
  progress,
  headingRef,
  announce,
  onAgain,
  onReset,
}: {
  kitId: string;
  total: number;
  state: SessionState;
  progress: CardProgress[];
  headingRef: RefObject<HTMLHeadingElement | null>;
  announce: string;
  onAgain: () => void;
  onReset: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const cards = state.cards;
  const summary = summarizePractice(cards, progress);
  const counts = { 1: 0, 2: 0, 3: 0 } as Record<Confidence, number>;
  for (const r of state.rated) counts[r.confidence] += 1;

  return (
    <section aria-label="Session complete" className="space-y-4">
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
      <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold text-slate-900">
        Session complete
      </h2>
      <p className="text-slate-800">
        You rated {state.rated.length} of {total} {total === 1 ? 'card' : 'cards'} this session
        {state.skipped.length > 0 ? ` and skipped ${state.skipped.length}` : ''}.
      </p>
      <ul className="text-slate-800" aria-label="This session by confidence">
        {CONFIDENCE_CHOICES.map((c) => (
          <li key={c.value}>
            {c.label}: {counts[c.value]}
          </li>
        ))}
      </ul>
      <p className="text-slate-800">
        Covered overall: {summary.covered} of {summary.total}{' '}
        {summary.total === 1 ? 'card' : 'cards'}
        {summary.uncovered_ids.length > 0
          ? `; ${summary.uncovered_ids.length} not covered yet`
          : ''}
        .
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onAgain}>Practise again</Button>
        <LinkButton href={`/kits/${kitId}`} variant="secondary">
          Back to the kit
        </LinkButton>
        {confirming ? (
          <div
            role="group"
            aria-label="Confirm resetting practice progress"
            className="flex flex-wrap items-center gap-2 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-950"
          >
            <span>Forget every rating for this kit?</span>
            <Button
              variant="danger"
              onClick={async () => {
                setResetError(null);
                if (await onReset()) setConfirming(false);
                else setResetError('Progress could not be reset. Please try again.');
              }}
            >
              Yes, reset
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="secondary" onClick={() => setConfirming(true)}>
            Reset my progress
          </Button>
        )}
      </div>
      {resetError ? <Alert tone="error">{resetError}</Alert> : null}
    </section>
  );
}
