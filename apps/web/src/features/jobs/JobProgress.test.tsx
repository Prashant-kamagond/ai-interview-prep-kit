// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import type { JobView } from '../../lib/api/jobs';
import { job } from '../../test/jobs';
import { JobProgress } from './JobProgress';

afterEach(cleanup);

const KIT = 'k'.repeat(24);
const done = job({ status: 'succeeded', stage: 'done', progress: 100, kit_id: KIT });
const network = () => new ApiError(0, 'NETWORK_ERROR', 'down');

function api(script: (JobView | Error)[]) {
  const get = vi.fn(async () => {
    const next = script.length > 1 ? script.shift()! : script[0]!;
    if (next instanceof Error) throw next;
    return next;
  });
  return { get };
}
const FAST = 5;

describe('what is shown while the job runs', () => {
  it('says it is checking before the first answer, and never shows success', () => {
    render(
      <JobProgress jobId="j" api={{ get: () => new Promise(() => undefined) }} intervalMs={FAST} />,
    );
    expect(screen.getByRole('status').textContent).toMatch(/Checking on the job/);
    expect(screen.queryByText(/ready/i)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows the stage and the progress number the server reported', async () => {
    render(
      <JobProgress
        jobId="j"
        api={api([job({ stage: 'generating', progress: 40 })])}
        intervalMs={FAST}
      />,
    );
    expect(await screen.findByText('Writing the kit…')).toBeTruthy();
    const bar = screen.getByLabelText('Progress reported by the server') as HTMLProgressElement;
    expect(bar.value).toBe(40);
    expect(screen.getByText('40% reported by the server')).toBeTruthy();
  });

  it('shows no bar and no percentage when the server has not reported progress', async () => {
    render(
      <JobProgress
        jobId="j"
        api={api([job({ status: 'queued', stage: null, progress: null })])}
        intervalMs={FAST}
      />,
    );
    expect(await screen.findByText('Waiting to start…')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(document.body.textContent).not.toMatch(/%/);
  });
});

describe('ending', () => {
  it('announces success only once the API says succeeded, with a link to the kit', async () => {
    const fake = api([job(), job({ progress: 40 }), done]);
    render(<JobProgress jobId="j" api={fake} intervalMs={FAST} />);
    expect(screen.queryByText('Your kit is ready.')).toBeNull();
    expect(await screen.findByText('Your kit is ready.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open kit' }).getAttribute('href')).toBe(
      `/kits/${KIT}`,
    );
    const calls = fake.get.mock.calls.length;
    await new Promise((r) => setTimeout(r, FAST * 8));
    expect(fake.get).toHaveBeenCalledTimes(calls); // polling stopped
  });

  it('shows a failure in plain words and stops polling', async () => {
    const fake = api([
      job(),
      job({ status: 'failed', error: { code: 'COMPANY_BLOCKED_BY_ROBOTS', message: 'raw' } }),
    ]);
    render(<JobProgress jobId="j" api={fake} intervalMs={FAST} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not be generated/);
    expect(alert.textContent).toMatch(/asks automated tools not to read it/);
    expect(screen.queryByRole('link', { name: 'Open kit' })).toBeNull();
    const calls = fake.get.mock.calls.length;
    await new Promise((r) => setTimeout(r, FAST * 8));
    expect(fake.get).toHaveBeenCalledTimes(calls);
  });

  it('does not claim success for a "succeeded" job that has no kit', async () => {
    render(
      <JobProgress
        jobId="j"
        api={api([job({ status: 'succeeded', kit_id: null })])}
        intervalMs={FAST}
      />,
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(/kit could not be found/);
    expect(screen.queryByText('Your kit is ready.')).toBeNull();
  });

  it('reports the end exactly once, with whether it succeeded', async () => {
    const onFinished = vi.fn();
    const { rerender } = render(
      <JobProgress jobId="j" api={api([done])} intervalMs={FAST} onFinished={onFinished} />,
    );
    await screen.findByText('Your kit is ready.');
    rerender(<JobProgress jobId="j" api={api([done])} intervalMs={FAST} onFinished={onFinished} />);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenCalledWith(true);
  });
});

describe('problems while checking', () => {
  it('after repeated network errors says it lost contact (not that the job failed) and can check again', async () => {
    const user = userEvent.setup();
    const script: (JobView | Error)[] = [network(), network(), network(), network()];
    const fake = {
      get: vi.fn(async () => {
        const next = script.shift();
        if (next instanceof Error) throw next;
        return next ?? done;
      }),
    };
    render(<JobProgress jobId="j" api={fake} intervalMs={FAST} />);
    const alert = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(alert.textContent).toMatch(/lost contact/);
    expect(alert.textContent).toMatch(/may still be running/);
    expect(screen.queryByText(/could not be generated/)).toBeNull();
    const callsAtStop = fake.get.mock.calls.length;
    expect(callsAtStop).toBe(4);
    await new Promise((r) => setTimeout(r, FAST * 8));
    expect(fake.get).toHaveBeenCalledTimes(callsAtStop); // no endless loop

    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Your kit is ready.')).toBeTruthy();
  });

  it('on an ended session stops without retry and does not offer to check again', async () => {
    const fake = api([new ApiError(401, 'SESSION_EXPIRED', 'x')]);
    render(<JobProgress jobId="j" api={fake} intervalMs={FAST} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/session ended/);
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to your kits' }).getAttribute('href')).toBe(
      '/kits',
    );
    expect(fake.get).toHaveBeenCalledTimes(1);
  });

  it('says a job that does not exist could not be found, with no retry', async () => {
    render(
      <JobProgress jobId="j" api={api([new ApiError(404, 'NOT_FOUND', 'x')])} intervalMs={FAST} />,
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be found/);
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
  });
});

describe('timers and requests', () => {
  it('stops polling when the component goes away', async () => {
    const fake = api([job()]);
    const { unmount } = render(<JobProgress jobId="j" api={fake} intervalMs={FAST} />);
    await waitFor(() => expect(fake.get.mock.calls.length).toBeGreaterThanOrEqual(2));
    unmount();
    const calls = fake.get.mock.calls.length;
    await new Promise((r) => setTimeout(r, FAST * 10));
    expect(fake.get.mock.calls.length).toBeLessThanOrEqual(calls + 1); // at most the request already in flight
  });

  it('does not start a second loop when the parent rerenders', async () => {
    const fake = api([job()]);
    const { rerender } = render(<JobProgress jobId="j" api={fake} intervalMs={60_000} />);
    for (let i = 0; i < 5; i++) {
      rerender(<JobProgress jobId="j" api={fake} intervalMs={60_000} label={`r${i}`} />);
    }
    await new Promise((r) => setTimeout(r, 50));
    // Each loop asks once at once and then waits a minute: one loop, one request.
    expect(fake.get).toHaveBeenCalledTimes(1);
  });
});
