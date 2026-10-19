import { describe, expect, it } from 'vitest';
import { JOB_STATUSES, type JobStatus } from '@trao/contracts';
import { allowedSources, canTransition, isTerminal } from './state.js';

const allowed: [JobStatus, JobStatus][] = [
  ['queued', 'running'],
  ['queued', 'failed'],
  ['running', 'succeeded'],
  ['running', 'failed'],
];

describe('job state machine', () => {
  it('permits exactly the documented transitions', () => {
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        const expected = allowed.some(([f, t]) => f === from && t === to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('treats succeeded and failed as terminal', () => {
    expect(JOB_STATUSES.filter(isTerminal)).toEqual(['succeeded', 'failed']);
  });

  it('cannot reach succeeded without passing through running', () => {
    expect(allowedSources('succeeded')).toEqual(['running']);
  });

  it('lists the source states for each target', () => {
    expect(allowedSources('running')).toEqual(['queued']);
    expect(allowedSources('failed')).toEqual(['queued', 'running']);
    expect(allowedSources('queued')).toEqual([]);
  });
});
