'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CardProgress } from '@trao/contracts';
import { orderForPractice, summarizePractice } from '@trao/core';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { LinkButton } from '../../components/ui/LinkButton';
import { Spinner } from '../../components/ui/Spinner';
import { ApiError } from '../../lib/api/client';
import {
  kitsApi as defaultKitsApi,
  practiceApi as defaultPracticeApi,
} from '../../lib/api/default';
import type { KitRecord, KitsApi } from '../../lib/api/kits';
import type { PracticeApi } from '../../lib/api/practice';
import { WRAP } from '../kit/KitDocument';
import { CONFIDENCE_CHOICES, PracticeSession } from './PracticeSession';

const KIT_ID = /^[0-9a-f]{24}$/i;

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; kit: KitRecord; progress: CardProgress[] }
  | { status: 'not-found' }
  | { status: 'session-ended' }
  | { status: 'error'; message: string };

function stateForError(error: unknown): LoadState {
  if (error instanceof ApiError) {
    if (error.status === 404) return { status: 'not-found' };
    if (error.status === 401) return { status: 'session-ended' };
    if (error.code === 'BAD_RESPONSE') {
      return {
        status: 'error',
        message: 'The server sent something this page could not read, so practice cannot start.',
      };
    }
    return { status: 'error', message: error.message };
  }
  return { status: 'error', message: 'Something went wrong while loading this practice session.' };
}

const backToKit = (id: string) => (
  <LinkButton href={`/kits/${id}`} variant="secondary">
    Back to the kit
  </LinkButton>
);

/** Loads a kit and the user's saved progress for it, then runs practice. Ownership is the server's call. */
export function PracticePage({
  id,
  kitsApi = defaultKitsApi,
  practiceApi = defaultPracticeApi,
  makeAttemptId,
}: {
  id: string;
  kitsApi?: Pick<KitsApi, 'get'>;
  practiceApi?: PracticeApi;
  makeAttemptId?: () => string;
}) {
  const [state, setState] = useState<LoadState>(
    KIT_ID.test(id) ? { status: 'loading' } : { status: 'not-found' },
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!KIT_ID.test(id)) return;
    const controller = new AbortController();
    Promise.all([
      kitsApi.get(id, { signal: controller.signal }),
      practiceApi.progress(id, { signal: controller.signal }),
    ])
      .then(([kit, progress]) => setState({ status: 'loaded', kit, progress: progress.cards }))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'ABORTED') return;
        setState(stateForError(error));
      });
    return () => controller.abort();
  }, [kitsApi, practiceApi, id, attempt]);

  if (state.status === 'loading') return <Spinner showLabel label="Loading your flashcards…" />;
  if (state.status === 'not-found') {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold text-slate-900">Kit not found</h1>
        <p className="text-slate-700">This kit does not exist, or it is not in your account.</p>
        <LinkButton href="/kits" variant="secondary">
          Back to your kits
        </LinkButton>
      </div>
    );
  }
  if (state.status === 'session-ended') {
    return (
      <div className="space-y-4">
        <Alert tone="error" title="Your session ended">
          Sign in again to practise.
        </Alert>
        <LinkButton href="/kits" variant="secondary">
          Back to your kits
        </LinkButton>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="space-y-4">
        <Alert
          tone="error"
          title="Could not start practice"
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setState({ status: 'loading' });
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          }
        >
          {state.message}
        </Alert>
        {backToKit(id)}
      </div>
    );
  }
  return (
    <PracticeFlow
      id={id}
      kit={state.kit}
      initialProgress={state.progress}
      practiceApi={practiceApi}
      {...(makeAttemptId ? { makeAttemptId } : {})}
    />
  );
}

interface RunState {
  n: number;
  cards: { id: string; front: string; back: string }[];
}

function PracticeFlow({
  id,
  kit,
  initialProgress,
  practiceApi,
  makeAttemptId,
}: {
  id: string;
  kit: KitRecord;
  initialProgress: CardProgress[];
  practiceApi: PracticeApi;
  makeAttemptId?: () => string;
}) {
  const flashcards = kit.kit.flashcards;
  const [progress, setProgress] = useState(initialProgress);
  // null: the start screen. Otherwise the session number and the cards, fixed when the session began.
  const [session, setSession] = useState<RunState | null>(null);
  const title = `${kit.kit.source.company || 'Kit'}${kit.kit.role.title ? `: ${kit.kit.role.title}` : ''}`;

  const begin = useCallback(
    (current: CardProgress[], n: number) => {
      const ordered = orderForPractice(flashcards, current);
      setSession({ n, cards: ordered.map((f) => ({ id: f.id, front: f.front, back: f.back })) });
    },
    [flashcards],
  );

  const onRecorded = useCallback((stored: CardProgress) => {
    setProgress((prev) => [...prev.filter((p) => p.card_id !== stored.card_id), stored]);
  }, []);

  const onReset = useCallback(async () => {
    try {
      await practiceApi.reset(id);
      setProgress([]);
      return true;
    } catch {
      return false;
    }
  }, [practiceApi, id]);

  const summary = summarizePractice(flashcards, progress);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">{backToKit(id)}</div>
        <h1 className={`text-2xl font-semibold text-slate-900 ${WRAP}`}>
          Practise flashcards
          <span className="block text-lg font-normal text-slate-700">{title}</span>
        </h1>
      </header>

      {flashcards.length === 0 ? (
        <EmptyState title="This kit has no flashcards" action={backToKit(id)}>
          There is nothing to practise yet. Add flashcards in the kit editor, then come back.
        </EmptyState>
      ) : session ? (
        <PracticeSession
          key={session.n}
          kitId={id}
          cards={session.cards}
          progress={progress}
          api={practiceApi}
          {...(makeAttemptId ? { makeAttemptId } : {})}
          onRecorded={onRecorded}
          onAgain={() => begin(progress, session.n + 1)}
          onReset={onReset}
        />
      ) : (
        <section aria-label="Before you start" className="space-y-4">
          <p className="text-slate-800">
            You will see one card at a time. Think of the answer, reveal it, then say how confident
            you felt. The next session starts with the cards you have not rated yet, then the ones
            you were least confident about.
          </p>
          <div className="rounded-lg border border-slate-200 bg-white p-4" aria-label="Coverage">
            <p className="font-medium text-slate-900" role="status">
              Covered: {summary.covered} of {summary.total} {summary.total === 1 ? 'card' : 'cards'}
              {summary.uncovered_ids.length > 0
                ? `; ${summary.uncovered_ids.length} not covered yet`
                : ''}
              .
            </p>
            {summary.covered > 0 ? (
              <ul
                className="mt-1 text-sm text-slate-700"
                aria-label="Covered cards by latest confidence"
              >
                {CONFIDENCE_CHOICES.map((c) => (
                  <li key={c.value}>
                    {c.label}: {summary.by_confidence[c.value]}
                  </li>
                ))}
              </ul>
            ) : null}
            {summary.uncovered_ids.length > 0 ? (
              <details className="mt-2">
                <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-indigo-800">
                  Cards not covered yet ({summary.uncovered_ids.length})
                </summary>
                <ul className="list-disc pl-5 text-sm text-slate-800">
                  {summary.uncovered_ids.map((cardId) => (
                    <li key={cardId} className={WRAP}>
                      {flashcards.find((f) => f.id === cardId)?.front ?? cardId}
                    </li>
                  ))}
                </ul>
              </details>
            ) : (
              <p className="mt-1 text-sm text-slate-700">
                Every card has been practised at least once.
              </p>
            )}
          </div>
          <Button onClick={() => begin(progress, 1)}>Start practising</Button>
        </section>
      )}
    </div>
  );
}
