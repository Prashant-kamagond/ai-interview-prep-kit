'use client';

import { useEffect, useRef } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { LinkButton } from '../../components/ui/LinkButton';
import { Spinner } from '../../components/ui/Spinner';
import type { JobsApi } from '../../lib/api/jobs';
import { jobsApi } from '../../lib/api/default';
import { describeJobFailure, describeStage, interruptionMessage, jobOutcome } from './tracker';
import { useJobTracker } from './useJobTracker';

export interface JobProgressProps {
  jobId: string;
  /** Names the job when several are listed, for example the case id. */
  label?: string;
  api?: Pick<JobsApi, 'get'>;
  intervalMs?: number;
  /** Called once, when the API confirms the job reached a final state (success or failure). */
  onFinished?: (success: boolean) => void;
}

/**
 * Shows where one generation job stands, using only what the API reports. The bar appears only when
 * the server has sent a progress number, success is announced only after the API says so, and an
 * interrupted check is shown as "we lost contact" with a way to check again, never as a result.
 */
export function JobProgress({
  jobId,
  label,
  api = jobsApi,
  intervalMs,
  onFinished,
}: JobProgressProps) {
  const { state, resume } = useJobTracker(api, jobId, intervalMs);
  const reported = useRef(false);
  const finishedCallback = useRef(onFinished);
  useEffect(() => {
    finishedCallback.current = onFinished;
  });

  const finishedJob = state.phase === 'finished' ? state.job : null;
  useEffect(() => {
    if (!finishedJob || reported.current) return;
    reported.current = true;
    finishedCallback.current?.(jobOutcome(finishedJob).kind === 'succeeded');
  }, [finishedJob]);

  const heading = label ? <p className="font-medium text-slate-900">{label}</p> : null;

  if (state.phase === 'finished') {
    const outcome = jobOutcome(state.job);
    if (outcome.kind === 'succeeded') {
      return (
        <div className="space-y-2">
          {heading}
          <Alert
            tone="success"
            title="Your kit is ready."
            action={<LinkButton href={`/kits/${outcome.kitId}`}>Open kit</LinkButton>}
          >
            The server confirmed that the kit was generated and saved.
          </Alert>
        </div>
      );
    }
    const failure =
      outcome.kind === 'failed'
        ? describeJobFailure(outcome.code, outcome.message)
        : 'The kit could not be generated.';
    return (
      <div className="space-y-2">
        {heading}
        <Alert tone="error" title="The kit could not be generated.">
          {failure}
        </Alert>
      </div>
    );
  }

  if (state.phase === 'interrupted') {
    return (
      <div className="space-y-2">
        {heading}
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
            ) : (
              <LinkButton href="/kits" variant="secondary">
                Back to your kits
              </LinkButton>
            )
          }
        >
          {interruptionMessage(state.reason)}
        </Alert>
      </div>
    );
  }

  const job = state.job;
  const stage = job ? describeStage(job) : null;
  const progress = job?.progress ?? null;
  return (
    <div className="space-y-2">
      {heading}
      <div className="rounded-md border border-slate-300 bg-white p-3 text-sm">
        <Spinner
          showLabel
          label={stage ? `${stage}…` : job ? 'Working on it…' : 'Checking on the job…'}
        />
        {progress !== null ? (
          <div className="mt-2">
            <progress
              className="h-2 w-full"
              max={100}
              value={progress}
              aria-label="Progress reported by the server"
            />
            <p className="mt-1 text-slate-600">{progress}% reported by the server</p>
          </div>
        ) : null}
        <p className="mt-2 text-slate-600">
          This can take a minute or two. You can leave this page open, or come back to it using the
          same address.
        </p>
      </div>
    </div>
  );
}
