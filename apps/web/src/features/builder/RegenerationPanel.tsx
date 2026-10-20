'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  QUESTION_CATEGORIES,
  regenerationReportSchema,
  type RegenerationReport,
  type RegenerationRequest,
  type ResearchSnapshot,
} from '@trao/contracts';
import type { BuilderDocument } from '@trao/core';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { ApiError } from '../../lib/api/client';
import type { BuilderApi } from '../../lib/api/builder';
import type { JobsApi, JobView } from '../../lib/api/jobs';
import {
  RegenerationInProgress,
  RegenerationRefused,
  type RegenerationApi,
} from '../../lib/api/regeneration';
import { Section, WRAP } from '../kit/KitDocument';
import { CATEGORY_LABELS } from '../kit/view';
import {
  describeJobFailure,
  describeStage,
  interruptionMessage,
  jobOutcome,
} from '../jobs/tracker';
import { useJobTracker } from '../jobs/useJobTracker';
import { SelectField } from './controls';
import { describeSkip, sectionName, sourceNote, summarizeReport } from './regeneration';
import type { BuilderStore } from './store';

export interface RegenerationPanelProps {
  id: string;
  store: BuilderStore;
  research: ResearchSnapshot;
  builderApi: Pick<BuilderApi, 'get'>;
  regenerationApi: RegenerationApi;
  jobsApi: Pick<JobsApi, 'get'>;
}

interface Run {
  jobId: string;
  /** Null when we joined a regeneration that was already running (its section is not known here). */
  request: RegenerationRequest | null;
  deduplicated: boolean;
}

const CARD = 'space-y-2 rounded-lg border border-slate-200 bg-white p-4';

function requestKey(r: RegenerationRequest): string {
  return r.section === 'questions' ? `questions:${r.category}` : r.section;
}

/**
 * Starts and follows section regenerations. Nothing here edits the kit: the server job does, and the
 * editor shows the result only when that cannot discard anything the user has not saved.
 *
 *  - Unsaved edits: the user must save first (or cancel). Regeneration never starts on top of edits
 *    that are not on the server.
 *  - One at a time: while a request is being made or a job is running, every start button is off,
 *    and a request the server reports as already running joins that job instead of starting another.
 *  - A refusal from the server (a missing source) is shown as the server said it, and no job exists.
 */
export function RegenerationPanel({
  id,
  store,
  research,
  builderApi,
  regenerationApi,
  jobsApi,
}: RegenerationPanelProps) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const doc = state.local;
  const [category, setCategory] = useState<(typeof QUESTION_CATEGORIES)[number]>('technical');
  const [confirming, setConfirming] = useState<RegenerationRequest | null>(null);
  const [working, setWorking] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [runActive, setRunActive] = useState(false);
  const [refusal, setRefusal] = useState<{
    section: string;
    message: string;
    reason: string;
  } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const lock = useRef(false);

  const blocked = state.status === 'conflict' || state.status === 'failed';
  const busy = working || runActive;
  const unsaved = state.pending.length > 0 || state.status !== 'synced';

  async function start(request: RegenerationRequest) {
    if (lock.current) return;
    lock.current = true;
    setWorking(true);
    setRefusal(null);
    setProblem(null);
    try {
      const { job, deduplicated } = await regenerationApi.start(id, request);
      setRun({ jobId: job.id, request, deduplicated });
      setRunActive(true);
    } catch (error) {
      if (error instanceof RegenerationRefused) {
        setRefusal({ section: sectionName(request), message: error.message, reason: error.reason });
      } else if (error instanceof RegenerationInProgress) {
        setRun({ jobId: error.jobId, request: null, deduplicated: true });
        setRunActive(true);
      } else if (error instanceof ApiError && error.status === 401) {
        setProblem('Your session ended. Sign in again, then start the regeneration.');
      } else if (error instanceof ApiError && (error.status === 0 || error.status === 429)) {
        setProblem(error.message);
      } else {
        setProblem('The regeneration could not be started. Please try again.');
      }
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }

  function ask(request: RegenerationRequest) {
    if (busy || blocked) return;
    if (unsaved) {
      setConfirming(request);
      return;
    }
    void start(request);
  }

  async function saveFirst(request: RegenerationRequest) {
    setConfirming(null);
    setProblem(null);
    setWorking(true);
    const saved = await store.whenSynced();
    setWorking(false);
    if (!saved) {
      setProblem(
        'Your edits could not be saved yet, so the regeneration was not started. Resolve the save problem shown above, then try again.',
      );
      return;
    }
    void start(request);
  }

  const cards: {
    request: RegenerationRequest;
    title: string;
    button: string;
    what: string;
    control?: ReactNode;
  }[] = [
    {
      request: { section: 'brief' },
      title: 'Company brief',
      button: 'Regenerate company brief',
      what: 'Writes a new brief from the stored company pages. Skipped if you edited or pinned the brief.',
    },
    {
      request: { section: 'questions', category },
      title: 'Questions, one category',
      button: `Regenerate ${CATEGORY_LABELS[category].toLowerCase()} questions`,
      what: 'Replaces the generated, unedited questions of that category with new ones. Your own, edited and pinned questions, questions on pinned days, and every other category stay as they are. Questions you deleted are not brought back.',
      control: (
        <SelectField
          label="Category"
          value={category}
          disabled={busy}
          options={QUESTION_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
          onChange={setCategory}
        />
      ),
    },
    {
      request: { section: 'schedule' },
      title: 'Schedule',
      button: 'Regenerate schedule',
      what: 'Re-plans the questions that are not on a pinned day across the days that are not pinned. Pinned days and any focus or minutes you set are kept, and the number of days does not change.',
    },
  ];

  return (
    <Section id="regeneration-section" title="Regenerate a section">
      <p className="text-slate-700">
        Regeneration runs on the server and replaces only the section you choose. It keeps what you
        wrote, edited or pinned, and it never replaces the kit you are looking at without telling
        you.
      </p>
      {blocked ? (
        <Alert tone="info">
          Resolve the save problem or conflict shown at the top of the page before regenerating: the
          editor must be in step with the server first.
        </Alert>
      ) : null}
      <ul className="space-y-3">
        {cards.map(({ request, title, button, what, control }) => {
          const note = sourceNote(request, research, doc.kit.role.requirements);
          const key = requestKey(request);
          return (
            <li key={key.startsWith('questions') ? 'questions' : key} className={CARD}>
              <h3 className="font-semibold text-slate-900">{title}</h3>
              <p className={`text-slate-800 ${WRAP}`}>{what}</p>
              <p className="text-sm text-slate-700">
                <span className="font-medium">Source:</span> {note.needs}
              </p>
              {!note.available && note.reason ? (
                <p
                  role="note"
                  className="rounded-md border border-amber-400 bg-amber-50 p-2 text-sm text-amber-950"
                >
                  {note.reason}
                </p>
              ) : null}
              {control}
              {confirming && requestKey(confirming) === key ? (
                <div
                  role="group"
                  aria-label={`Unsaved edits before regenerating ${sectionName(request)}`}
                  className="space-y-2 rounded-md border border-sky-300 bg-sky-50 p-3 text-sm text-sky-950"
                >
                  <p>
                    You have {state.pending.length || 'some'} unsaved{' '}
                    {state.pending.length === 1 ? 'edit' : 'edits'}. Regeneration works on the saved
                    kit, so they must be saved first or they would clash with the result.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => void saveFirst(request)}>Save, then regenerate</Button>
                    <Button variant="secondary" onClick={() => setConfirming(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="secondary" disabled={busy || blocked} onClick={() => ask(request)}>
                  {button}
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {working && !runActive ? <Spinner showLabel label="Starting…" /> : null}
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      {refusal ? (
        <Alert
          tone="error"
          title={`Cannot regenerate ${refusal.section}`}
          action={
            <Button variant="secondary" onClick={() => setRefusal(null)}>
              Dismiss
            </Button>
          }
        >
          {refusal.message}
        </Alert>
      ) : null}
      {run ? (
        <RegenerationRun
          key={run.jobId}
          id={id}
          run={run}
          store={store}
          doc={doc}
          builderApi={builderApi}
          jobsApi={jobsApi}
          onSettled={() => setRunActive(false)}
          onClose={() => setRun(null)}
        />
      ) : null}
    </Section>
  );
}

type Adoption = 'pending' | 'adopted' | 'kept' | 'failed';

function RegenerationRun({
  id,
  run,
  store,
  doc,
  builderApi,
  jobsApi,
  onSettled,
  onClose,
}: {
  id: string;
  run: Run;
  store: BuilderStore;
  doc: BuilderDocument;
  builderApi: Pick<BuilderApi, 'get'>;
  jobsApi: Pick<JobsApi, 'get'>;
  onSettled: () => void;
  onClose: () => void;
}) {
  const { state, resume } = useJobTracker(jobsApi, run.jobId);
  const [adoption, setAdoption] = useState<Adoption>('pending');
  const settled = state.phase !== 'tracking';
  const finishedOnce = useRef(false);

  useEffect(() => {
    if (settled && !finishedOnce.current) {
      finishedOnce.current = true;
      onSettled();
    }
  }, [settled, onSettled]);

  const job: JobView | null = state.job;
  const outcome = state.phase === 'finished' ? jobOutcome(state.job) : null;
  const succeeded = outcome?.kind === 'succeeded';

  async function load(): Promise<Adoption> {
    try {
      const fresh = await builderApi.get(id);
      if (store.adopt(fresh)) return 'adopted';
      // Nothing is replaced when it could discard unsaved edits (or when it is not newer).
      return store.getState().server.version >= fresh.version ? 'adopted' : 'kept';
    } catch {
      return 'failed';
    }
  }

  // After a success, show the regenerated kit, but only if no unsaved edit would be lost.
  const adoptStarted = useRef(false);
  useEffect(() => {
    if (!succeeded || adoptStarted.current) return;
    adoptStarted.current = true;
    void load().then(setAdoption);
  }, [succeeded]);

  const parsed = job?.report ? regenerationReportSchema.safeParse(job.report) : null;
  const label = run.request ? sectionName(run.request) : 'a section';

  return (
    <div className="space-y-3" aria-label="Regeneration progress">
      {run.deduplicated ? (
        <Alert tone="info">
          {run.request
            ? 'An identical regeneration was already running, so you are following that one.'
            : 'Another regeneration for this kit was already running, so you are following that one.'}
        </Alert>
      ) : null}

      {state.phase === 'tracking' ? (
        <div role="status" className="rounded-md border border-slate-300 bg-white p-3 text-sm">
          <Spinner
            showLabel
            label={`Regenerating ${label}${job && describeStage(job) ? `: ${describeStage(job)}` : ''}…`}
          />
          {job?.progress !== null && job?.progress !== undefined ? (
            <div className="mt-2">
              <progress
                className="h-2 w-full"
                max={100}
                value={job.progress}
                aria-label="Progress reported by the server"
              />
              <p className="mt-1 text-slate-600">{job.progress}% reported by the server</p>
            </div>
          ) : null}
          <p className="mt-2 text-slate-600">
            This can take a minute. You can keep editing; unsaved edits are not affected.
          </p>
        </div>
      ) : null}

      {state.phase === 'interrupted' ? (
        <Alert
          tone="error"
          title="Status unknown"
          action={
            state.reason === 'network' ||
            state.reason === 'timeout' ||
            state.reason === 'unexpected' ? (
              <Button variant="secondary" onClick={resume}>
                Check again
              </Button>
            ) : null
          }
        >
          {interruptionMessage(state.reason)}
        </Alert>
      ) : null}

      {outcome?.kind === 'failed' ? (
        <Alert
          tone="error"
          title={`Could not regenerate ${label}`}
          action={
            <div className="flex flex-wrap gap-2">
              {outcome.code === 'VERSION_CONFLICT' ? (
                <Button variant="secondary" onClick={() => void load().then(setAdoption)}>
                  Load the current kit
                </Button>
              ) : null}
              <Button variant="secondary" onClick={onClose}>
                Dismiss
              </Button>
            </div>
          }
        >
          {describeJobFailure(outcome.code, outcome.message)} The kit was not changed.
          {adoption === 'adopted' && outcome.code === 'VERSION_CONFLICT'
            ? ' The editor now shows the current kit.'
            : ''}
          {adoption === 'kept'
            ? ' You have unsaved edits, so the editor still shows your version.'
            : ''}
        </Alert>
      ) : null}

      {succeeded ? (
        <div className="space-y-3">
          <Alert
            tone="success"
            title={`Regenerated ${label}`}
            action={
              <Button variant="secondary" onClick={onClose}>
                Close report
              </Button>
            }
          >
            {parsed?.success
              ? summarizeReport(parsed.data)
              : 'The server confirmed the regeneration.'}{' '}
            {adoption === 'adopted' ? 'The editor now shows the regenerated kit.' : null}
            {adoption === 'pending' ? 'Loading the regenerated kit…' : null}
            {adoption === 'kept'
              ? 'You made edits while it ran, so the editor still shows your version and your edits are kept. When they are saved you will be asked how to combine them with the regenerated kit.'
              : null}
            {adoption === 'failed'
              ? 'The regenerated kit could not be loaded; reload the page to see it.'
              : null}
          </Alert>
          {parsed?.success ? <ReportView report={parsed.data} doc={doc} /> : null}
          {adoption === 'kept' ? (
            <Button variant="secondary" onClick={() => void load().then(setAdoption)}>
              Try loading the regenerated kit again
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ReportView({ report, doc }: { report: RegenerationReport; doc: BuilderDocument }) {
  const labelFor = (itemId: string) => {
    if (itemId === 'brief' || itemId.startsWith('day '))
      return itemId === 'brief' ? 'The company brief' : `Day ${itemId.slice(4)}`;
    const q = doc.kit.questions.find((x) => x.id === itemId);
    return q ? `${itemId}: ${q.prompt}` : itemId;
  };
  const requirement = (rid: string) => doc.kit.role.requirements.find((r) => r.id === rid);
  const list = (title: string, ids: string[], empty: string) => (
    <div>
      <h4 className="font-medium text-slate-900">
        {title} ({ids.length})
      </h4>
      {ids.length === 0 ? (
        <p className="text-sm text-slate-600">{empty}</p>
      ) : (
        <ul className="list-disc pl-5 text-sm text-slate-800">
          {ids.map((x) => (
            <li key={x} className={WRAP}>
              {labelFor(x)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <section
      aria-label="Regeneration report"
      className="space-y-3 rounded-lg border border-slate-200 bg-white p-4"
    >
      <h3 className="font-semibold text-slate-900">What happened</h3>
      {report.section === 'schedule' ? (
        <>
          <p className="text-sm text-slate-800">
            Pinned days kept: {report.days?.kept.length ? report.days.kept.join(', ') : 'none'}.
            Days re-planned:{' '}
            {report.days?.reallocated.length ? report.days.reallocated.join(', ') : 'none'}.
          </p>
        </>
      ) : (
        <>
          {list('Kept', report.kept, 'Nothing was kept back.')}
          {list('Replaced', report.replaced, 'Nothing was replaced.')}
          {list('Added', report.added, 'Nothing was added.')}
        </>
      )}
      <div>
        <h4 className="font-medium text-slate-900">Skipped ({report.skipped.length})</h4>
        {report.skipped.length === 0 ? (
          <p className="text-sm text-slate-600">Nothing was skipped.</p>
        ) : (
          <ul className="list-disc pl-5 text-sm text-slate-800">
            {report.skipped.map((s, i) => (
              <li key={i} className={WRAP}>
                {describeSkip(s.reason)}: {s.detail}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h4 className="font-medium text-slate-900">
          Coverage gaps ({report.gaps.uncovered_ids.length})
        </h4>
        {report.gaps.uncovered_ids.length === 0 ? (
          <p className="text-sm text-slate-800">Every requirement is covered by a question.</p>
        ) : (
          <ul className="list-disc pl-5 text-sm text-slate-800">
            {report.gaps.uncovered_ids.map((rid) => (
              <li key={rid} className={WRAP}>
                <code>{rid}</code> {requirement(rid)?.text ?? ''}{' '}
                <strong>
                  {report.gaps.uncovered_must_ids.includes(rid)
                    ? '(must-have, not covered)'
                    : '(not covered)'}
                </strong>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
