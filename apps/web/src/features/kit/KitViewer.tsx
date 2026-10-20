'use client';

import { useEffect, useState } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { LinkButton } from '../../components/ui/LinkButton';
import { Spinner } from '../../components/ui/Spinner';
import { ApiError } from '../../lib/api/client';
import { kitsApi } from '../../lib/api/default';
import type { KitRecord, KitsApi } from '../../lib/api/kits';
import { KitDocument } from './KitDocument';

type ViewState =
  | { status: 'loading' }
  | { status: 'loaded'; record: KitRecord }
  | { status: 'not-found' }
  | { status: 'session-ended' }
  | { status: 'error'; message: string };

/** What the address of a stored kit looks like; anything else cannot exist, so it is never requested. */
const KIT_ID = /^[0-9a-f]{24}$/i;

function stateForError(error: unknown): ViewState {
  if (error instanceof ApiError) {
    if (error.status === 404) return { status: 'not-found' };
    if (error.status === 401) return { status: 'session-ended' };
    if (error.code === 'BAD_RESPONSE') {
      return {
        status: 'error',
        message: 'The server sent a kit this page could not read, so it is not shown.',
      };
    }
    return { status: 'error', message: error.message };
  }
  return { status: 'error', message: 'Something went wrong while loading this kit.' };
}

/**
 * Loads one kit and shows it read-only. The server decides who may see a kit: a kit that is not the
 * signed-in user's looks exactly like one that does not exist (not found).
 */
export function KitViewer({ id, api = kitsApi }: { id: string; api?: Pick<KitsApi, 'get'> }) {
  const [state, setState] = useState<ViewState>(
    KIT_ID.test(id) ? { status: 'loading' } : { status: 'not-found' },
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!KIT_ID.test(id)) return;
    const controller = new AbortController();
    api
      .get(id, { signal: controller.signal })
      .then((record) => setState({ status: 'loaded', record }))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'ABORTED') return;
        setState(stateForError(error));
      });
    return () => controller.abort();
  }, [api, id, attempt]);

  if (state.status === 'loaded') return <KitDocument record={state.record} />;

  const back = (
    <LinkButton href="/kits" variant="secondary">
      Back to your kits
    </LinkButton>
  );
  if (state.status === 'loading') return <Spinner showLabel label="Loading your kit…" />;
  if (state.status === 'not-found') {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold text-slate-900">Kit not found</h1>
        <p className="text-slate-700">
          This kit does not exist, or it is not in your account. Check the link, or pick a kit from
          your list.
        </p>
        {back}
      </div>
    );
  }
  if (state.status === 'session-ended') {
    return (
      <div className="space-y-4">
        <Alert tone="error" title="Your session ended">
          Sign in again to see this kit.
        </Alert>
        {back}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <Alert
        tone="error"
        title="Could not load this kit"
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
      {back}
    </div>
  );
}
