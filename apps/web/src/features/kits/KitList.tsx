'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { LinkButton } from '../../components/ui/LinkButton';
import { Spinner } from '../../components/ui/Spinner';
import { kitsApi } from '../../lib/api/default';
import { ApiError } from '../../lib/api/client';
import type { KitSummary, KitsApi } from '../../lib/api/kits';

type ListState =
  | { status: 'loading' }
  | { status: 'loaded'; kits: KitSummary[] }
  | { status: 'error'; message: string; canRetry: boolean };

function describeListError(error: unknown): { message: string; canRetry: boolean } {
  if (error instanceof ApiError) {
    // The session bus has already sent the user to sign in; do not offer a retry that cannot work.
    if (error.status === 401)
      return { message: 'Your session ended. Sign in again.', canRetry: false };
    return { message: error.message, canRetry: true };
  }
  return { message: 'Something went wrong while loading your kits.', canRetry: true };
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The signed-in user's kits. The API returns only the caller's own kits; nothing here filters by
 * owner. Each state (loading, failed, empty, populated) is a distinct, announced view.
 */
export function KitList({ api = kitsApi }: { api?: Pick<KitsApi, 'list'> }) {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api
      .list({ signal: controller.signal })
      .then((kits) => setState({ status: 'loaded', kits }))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'ABORTED') return;
        setState({ status: 'error', ...describeListError(error) });
      });
    return () => controller.abort();
  }, [api, attempt]);

  function retry() {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-slate-900">Your kits</h1>
        <LinkButton href="/kits/new">Create a kit</LinkButton>
      </div>

      {state.status === 'loading' ? (
        <Spinner showLabel label="Loading your kits…" />
      ) : state.status === 'error' ? (
        <Alert
          tone="error"
          title="Could not load your kits"
          action={
            state.canRetry ? (
              <Button variant="secondary" onClick={retry}>
                Try again
              </Button>
            ) : null
          }
        >
          {state.message}
        </Alert>
      ) : state.kits.length === 0 ? (
        <EmptyState
          title="No kits yet"
          action={<LinkButton href="/kits/new">Create your first kit</LinkButton>}
        >
          A kit is a company-specific interview plan built from a job description and the
          company&apos;s own website.
        </EmptyState>
      ) : (
        <ul
          aria-label="Your kits"
          className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white"
        >
          {state.kits.map((kit) => (
            <li key={kit.id}>
              <Link
                href={`/kits/${kit.id}`}
                className="flex flex-col gap-1 p-4 hover:bg-slate-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-700 sm:flex-row sm:items-baseline sm:justify-between"
              >
                <span className="min-w-0">
                  <span className="block font-medium text-slate-900 [overflow-wrap:anywhere]">
                    {kit.company}
                  </span>
                  <span className="block text-sm text-slate-700 [overflow-wrap:anywhere]">
                    {kit.role}
                  </span>
                </span>
                <span className="text-sm text-slate-600">
                  Created <time dateTime={kit.created_at}>{formatDate(kit.created_at)}</time>
                  {kit.updated_at !== kit.created_at ? (
                    <>
                      {' · '}Updated{' '}
                      <time dateTime={kit.updated_at}>{formatDate(kit.updated_at)}</time>
                    </>
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
