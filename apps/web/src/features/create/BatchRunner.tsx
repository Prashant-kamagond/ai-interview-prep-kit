'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { jobsApi } from '../../lib/api/default';
import type { JobsApi } from '../../lib/api/jobs';
import { JobProgress } from '../jobs/JobProgress';
import { describeSubmitError } from './form';
import { rowLabel, type BatchRow } from './batch-input';
import type { GenerationRequest } from '@trao/contracts';

export type ReadyRow = BatchRow & { request: GenerationRequest };

export interface BatchRunnerProps {
  rows: ReadyRow[];
  api?: Pick<JobsApi, 'submit' | 'get'>;
  /** Called with every job id created so far, so the page address can remember them. */
  onJobsChanged?: (jobIds: string[]) => void;
}

interface Started {
  row: ReadyRow;
  jobId: string;
}

/**
 * Runs the valid cases one after another: each is submitted as its own generation job, and the next
 * is submitted only after the API reports the previous one finished. That keeps the load on the
 * server and the model provider low and means there is exactly one job being polled at a time. A
 * failed case does not stop the others; a failure to even start one stops the queue and says which.
 */
export function BatchRunner({ rows, api = jobsApi, onJobsChanged }: BatchRunnerProps) {
  const [started, setStarted] = useState<Started[]>([]);
  const [finished, setFinished] = useState(0);
  const [startError, setStartError] = useState<string | null>(null);
  const startedRef = useRef<Started[]>([]);
  const submitting = useRef(false);

  const startNext = useCallback(async () => {
    if (submitting.current) return;
    const row = rows[startedRef.current.length];
    if (!row) return;
    submitting.current = true;
    setStartError(null);
    try {
      const { job } = await api.submit(row.request);
      startedRef.current = [...startedRef.current, { row, jobId: job.id }];
      setStarted(startedRef.current);
      onJobsChanged?.(startedRef.current.map((s) => s.jobId));
    } catch (error) {
      const failure = describeSubmitError(error);
      setStartError(failure.form ?? 'This case was not accepted by the server.');
    } finally {
      submitting.current = false;
    }
  }, [rows, api, onJobsChanged]);

  // Start the first case, and the next one each time the previous one has finished.
  useEffect(() => {
    if (started.length === finished && started.length < rows.length && startError === null) {
      void startNext();
    }
  }, [started.length, finished, rows.length, startError, startNext]);

  const waiting = rows.slice(started.length);
  return (
    <div className="space-y-4">
      <p role="status" className="text-sm text-slate-700">
        {finished} of {rows.length} finished
        {finished < rows.length && startError === null
          ? '. Cases run one after another; each starts when the previous one is done.'
          : '.'}
      </p>
      <ol className="space-y-4">
        {started.map(({ row, jobId }) => (
          <li key={jobId}>
            <JobProgress
              jobId={jobId}
              label={rowLabel(row)}
              api={api}
              onFinished={() => setFinished((n) => n + 1)}
            />
          </li>
        ))}
        {waiting.map((row, i) => (
          <li key={`${row.position}-${row.id}`} className="text-sm text-slate-600">
            <span className="font-medium text-slate-900">{rowLabel(row)}</span>
            {' — '}
            {i === 0 && startError !== null ? 'could not be started' : 'waiting'}
          </li>
        ))}
      </ol>
      {startError !== null ? (
        <Alert
          tone="error"
          title={`Could not start ${waiting[0] ? rowLabel(waiting[0]) : 'the next case'}`}
          action={
            <Button variant="secondary" onClick={() => void startNext()}>
              Try again
            </Button>
          }
        >
          {startError} The remaining cases have not been started.
        </Alert>
      ) : null}
    </div>
  );
}
