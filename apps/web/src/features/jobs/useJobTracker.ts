'use client';

import { useCallback, useEffect, useReducer, useState } from 'react';
import type { JobsApi } from '../../lib/api/jobs';
import { initialTrackState, trackJob, trackReducer, type TrackState } from './tracker';

/**
 * Follows one job for as long as the component is mounted and the job is unfinished. One effect owns
 * one loop: leaving the page, changing the job or finishing aborts it, so there is never a second
 * timer or an overlapping request, and a rerender does nothing.
 */
export function useJobTracker(
  api: Pick<JobsApi, 'get'>,
  jobId: string,
  intervalMs?: number,
): { state: TrackState; resume: () => void } {
  const [state, dispatch] = useReducer(trackReducer, initialTrackState);
  const [attempt, setAttempt] = useState(0);
  const active = state.phase === 'tracking';

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void trackJob(api, jobId, {
      signal: controller.signal,
      ...(intervalMs === undefined ? {} : { intervalMs }),
      onUpdate: (job) => dispatch({ type: 'update', job }),
    }).then((result) => {
      if (result.type === 'interrupted') dispatch({ type: 'interrupted', reason: result.reason });
    });
    return () => controller.abort();
    // `active` is a dependency only so an interruption stops the loop and a resume starts a new one.
  }, [api, jobId, intervalMs, attempt, active]);

  const resume = useCallback(() => {
    dispatch({ type: 'resume' });
    setAttempt((n) => n + 1);
  }, []);

  return { state, resume };
}
