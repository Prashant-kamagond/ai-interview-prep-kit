'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { BuilderDocumentResponse } from '@trao/contracts';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { LinkButton } from '../../components/ui/LinkButton';
import { Spinner } from '../../components/ui/Spinner';
import { ApiError } from '../../lib/api/client';
import {
  builderApi,
  jobsApi as defaultJobsApi,
  regenerationApi as defaultRegenerationApi,
} from '../../lib/api/default';
import type { JobsApi } from '../../lib/api/jobs';
import type { RegenerationApi } from '../../lib/api/regeneration';
import { RegenerationPanel } from './RegenerationPanel';
import type { BuilderApi } from '../../lib/api/builder';
import { ConflictPanel, DraftPrompt, FailureBanner, SaveStatus } from './panels';
import {
  BriefSection,
  CoverageSection,
  FlashcardsSection,
  QuestionsSection,
  RequirementsSection,
  ScheduleSection,
} from './sections';
import { BuilderStore, sessionDrafts, type DraftStorage } from './store';

const KIT_ID = /^[0-9a-f]{24}$/i;

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; document: BuilderDocumentResponse }
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
        message: 'The server sent a kit this page could not read, so it is not shown.',
      };
    }
    return { status: 'error', message: error.message };
  }
  return { status: 'error', message: 'Something went wrong while loading this kit.' };
}

const BACK = (
  <LinkButton href="/kits" variant="secondary">
    Back to your kits
  </LinkButton>
);

/** Loads a kit and its builder state, then hands it to the editor. The server decides who may see it. */
export function BuilderEditor({
  id,
  api = builderApi,
  drafts = sessionDrafts,
  debounceMs,
  regenerationApi = defaultRegenerationApi,
  jobsApi = defaultJobsApi,
}: {
  id: string;
  api?: Pick<BuilderApi, 'get' | 'applyOperations'>;
  drafts?: DraftStorage;
  debounceMs?: number;
  regenerationApi?: RegenerationApi;
  jobsApi?: Pick<JobsApi, 'get'>;
}) {
  const [state, setState] = useState<LoadState>(
    KIT_ID.test(id) ? { status: 'loading' } : { status: 'not-found' },
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!KIT_ID.test(id)) return;
    const controller = new AbortController();
    api
      .get(id, { signal: controller.signal })
      .then((document) => setState({ status: 'loaded', document }))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'ABORTED') return;
        setState(stateForError(error));
      });
    return () => controller.abort();
  }, [api, id, attempt]);

  if (state.status === 'loaded') {
    return (
      <EditorScreen
        key={`${id}:${attempt}`}
        id={id}
        api={api}
        drafts={drafts}
        document={state.document}
        builderApi={api}
        regenerationApi={regenerationApi}
        jobsApi={jobsApi}
        {...(debounceMs === undefined ? {} : { debounceMs })}
      />
    );
  }
  if (state.status === 'loading') return <Spinner showLabel label="Loading your kit…" />;
  if (state.status === 'not-found') {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold text-slate-900">Kit not found</h1>
        <p className="text-slate-700">
          This kit does not exist, or it is not in your account. Check the link, or pick a kit from
          your list.
        </p>
        {BACK}
      </div>
    );
  }
  if (state.status === 'session-ended') {
    return (
      <div className="space-y-4">
        <Alert tone="error" title="Your session ended">
          Sign in again to see this kit.
        </Alert>
        {BACK}
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
      {BACK}
    </div>
  );
}

function EditorScreen({
  id,
  api,
  drafts,
  document,
  builderApi,
  regenerationApi,
  jobsApi,
  debounceMs,
}: {
  id: string;
  api: Pick<BuilderApi, 'applyOperations'>;
  drafts: DraftStorage;
  document: BuilderDocumentResponse;
  builderApi: Pick<BuilderApi, 'get'>;
  regenerationApi: RegenerationApi;
  jobsApi: Pick<JobsApi, 'get'>;
  debounceMs?: number;
}) {
  const [store] = useState(
    () =>
      new BuilderStore(id, api, document, {
        drafts,
        ...(debounceMs === undefined ? {} : { debounceMs }),
      }),
  );
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const [draft, setDraft] = useState<unknown[] | null>(() => drafts.read(id));

  // Leaving the page sends what is still unsaved, and the browser warns before closing with unsaved edits.
  useEffect(() => () => store.detach(), [store]);
  const unsaved = state.pending.length > 0;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  const doc = state.local;
  const frozen = state.status === 'conflict';
  const props = { doc, act: store.edit.bind(store), disabled: frozen };
  const kit = doc.kit;

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {BACK}
            <LinkButton href={`/kits/${id}/practice`} variant="secondary">
              Practise flashcards
            </LinkButton>
          </div>
          <SaveStatus state={state} store={store} />
        </div>
        <h1 className="text-2xl font-semibold text-slate-900 [overflow-wrap:anywhere]">
          {kit.source.company || 'Unnamed company'}
          <span className="block text-lg font-normal text-slate-700">
            {kit.role.title || kit.source.role || 'Untitled role'}
          </span>
        </h1>
        <nav aria-label="On this page">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {[
              ['company-section-heading', 'Company'],
              ['role-section-heading', 'Requirements'],
              ['questions-section-heading', 'Questions'],
              ['flashcards-section-heading', 'Flashcards'],
              ['schedule-section-heading', 'Schedule'],
              ['regeneration-section-heading', 'Regenerate'],
              ['coverage-section-heading', 'Coverage'],
            ].map(([target, label]) => (
              <li key={target}>
                <a
                  href={`#${target}`}
                  className="inline-flex min-h-11 items-center text-indigo-800 underline underline-offset-2"
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      {draft ? (
        <DraftPrompt
          count={draft.length}
          onRestore={() => {
            store.restore(draft);
            setDraft(null);
          }}
          onDiscard={() => {
            drafts.write(id, []);
            setDraft(null);
          }}
        />
      ) : null}
      <ConflictPanel state={state} store={store} />
      <FailureBanner state={state} store={store} />
      {state.notice ? (
        <Alert
          tone="error"
          title="That change was not applied"
          action={
            <Button variant="secondary" onClick={() => store.dismissNotice()}>
              Dismiss
            </Button>
          }
        >
          {state.notice}
        </Alert>
      ) : null}

      <CoverageSection doc={doc} />
      <BriefSection
        key={`${kit.company_brief.summary}|${kit.company_brief.what_they_do}`}
        {...props}
      />
      <RequirementsSection {...props} />
      <QuestionsSection {...props} />
      <FlashcardsSection {...props} />
      <ScheduleSection {...props} />
      <RegenerationPanel
        id={id}
        store={store}
        research={state.server.research}
        builderApi={builderApi}
        regenerationApi={regenerationApi}
        jobsApi={jobsApi}
      />
    </div>
  );
}
