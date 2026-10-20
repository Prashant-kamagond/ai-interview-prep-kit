'use client';

import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '../../components/ui/Alert';
import { LinkButton } from '../../components/ui/LinkButton';
import type { JobsApi } from '../../lib/api/jobs';
import { JobProgress } from '../jobs/JobProgress';
import { BatchForm } from './BatchForm';
import { MAX_BATCH_CASES } from './batch-input';
import { SingleForm } from './SingleForm';

type Mode = 'single' | 'batch';

const JOB_ID = /^[a-f0-9]{24}$/;
/** Many recovered jobs are checked less often, to stay well inside the API's request limit. */
const RECOVERED_INTERVAL_MS = 5_000;

/** The job ids a page address names. Anything that is not a job id is ignored, never sent to the API. */
export function jobIdsFromParams(params: Pick<URLSearchParams, 'get'>): {
  single: string | null;
  many: string[];
  ignored: boolean;
} {
  const rawSingle = params.get('job');
  const rawMany = params.get('jobs');
  const single = rawSingle && JOB_ID.test(rawSingle) ? rawSingle : null;
  const parts = rawMany ? rawMany.split(',') : [];
  const many = [...new Set(parts.filter((p) => JOB_ID.test(p)))].slice(0, MAX_BATCH_CASES);
  const ignored =
    (rawSingle !== null && single === null) || (rawMany !== null && many.length !== parts.length);
  return { single, many, ignored };
}

/** Puts job ids in the address without a navigation, so a reload can pick the jobs up again. */
function rememberJobs(query: string): void {
  try {
    window.history.replaceState(
      window.history.state,
      '',
      query ? `/kits/new?${query}` : '/kits/new',
    );
  } catch {
    // Remembering is a convenience; the jobs still run if the address cannot be updated.
  }
}

export function CreateKitPage({ api }: { api?: Pick<JobsApi, 'submit' | 'get'> }) {
  const params = useSearchParams();
  // Read once: later address changes are made by this page itself and must not rebuild it.
  const [recovered] = useState(() => jobIdsFromParams(params));
  const [mode, setMode] = useState<Mode>(recovered.many.length > 0 ? 'batch' : 'single');
  const [resetKey, setResetKey] = useState(0);
  const [showRecovered, setShowRecovered] = useState(recovered.many.length > 0);

  function reset() {
    rememberJobs('');
    setShowRecovered(false);
    setResetKey((n) => n + 1);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Create a kit</h1>
        <p className="mt-1 text-slate-600">
          Give us a job description and the company&apos;s website. We research the company and
          build your preparation plan.
        </p>
      </div>

      {recovered.ignored ? (
        <Alert tone="info">
          Part of the job link in the address was not valid and was ignored.
        </Alert>
      ) : null}

      {showRecovered ? (
        <section className="space-y-4" aria-label="Jobs from the link">
          <Alert tone="info">
            Showing {recovered.many.length} {recovered.many.length === 1 ? 'job' : 'jobs'} from the
            link. Case names are not kept after a reload, and cases that had not started yet when
            the page was closed were not submitted.
          </Alert>
          <ol className="space-y-4">
            {recovered.many.map((id, i) => (
              <li key={id}>
                <JobProgress
                  jobId={id}
                  label={`Job ${i + 1} of ${recovered.many.length}`}
                  api={api}
                  intervalMs={RECOVERED_INTERVAL_MS}
                />
              </li>
            ))}
          </ol>
          <LinkButton href="/kits/new" variant="secondary" onClick={reset}>
            Create another kit
          </LinkButton>
        </section>
      ) : (
        <>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-800">What are you creating?</legend>
            <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
              {(
                [
                  ['single', 'One role'],
                  ['batch', 'Several roles from a file'],
                ] as const
              ).map(([value, text]) => (
                <label key={value} className="flex min-h-11 items-center gap-2 text-slate-900">
                  <input
                    type="radio"
                    name="mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                    className="size-4"
                  />
                  {text}
                </label>
              ))}
            </div>
          </fieldset>

          {/* Both stay mounted so switching never loses typed text or hides a running job. */}
          <div hidden={mode !== 'single'}>
            <SingleForm
              key={`single-${resetKey}`}
              {...(api ? { api } : {})}
              initialJobId={resetKey === 0 ? recovered.single : null}
              onJobCreated={(id) => rememberJobs(`job=${id}`)}
              onReset={reset}
            />
          </div>
          <div hidden={mode !== 'batch'}>
            <BatchForm
              key={`batch-${resetKey}`}
              {...(api ? { api } : {})}
              onJobsChanged={(ids) => rememberJobs(`jobs=${ids.join(',')}`)}
              onReset={reset}
            />
          </div>
        </>
      )}
    </div>
  );
}
