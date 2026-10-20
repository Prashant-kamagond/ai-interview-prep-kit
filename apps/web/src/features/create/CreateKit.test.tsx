// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import type { JobView, JobsApi, SubmitResult } from '../../lib/api/jobs';
import { deferred } from '../../test/auth';
import { job } from '../../test/jobs';
import { resetNavigation } from '../../test/navigation';
import { CreateKitPage, jobIdsFromParams } from './CreateKitPage';

vi.mock('next/navigation', async () => (await import('../../test/navigation')).navigationMock);

beforeEach(() => resetNavigation('/kits/new'));
afterEach(cleanup);

const ID1 = '1'.repeat(24);
const ID2 = '2'.repeat(24);
const KIT = 'k'.repeat(24);
const done = (id: string) =>
  job({ id, status: 'succeeded', stage: 'done', progress: 100, kit_id: KIT });
const queued = (id: string): SubmitResult => ({
  job: job({ id, status: 'queued', stage: null, progress: null }),
  deduplicated: false,
});

/** Submits hand out ids in order; every job is already finished when asked about. */
function fakeApi(
  over: {
    submit?: (...args: never[]) => Promise<SubmitResult>;
    get?: (...args: never[]) => Promise<JobView>;
  } = {},
) {
  const ids = [ID1, ID2, '3'.repeat(24), '4'.repeat(24)];
  return {
    submit: vi.fn<JobsApi['submit']>(
      (over.submit ?? (async () => queued(ids.shift()!))) as JobsApi['submit'],
    ),
    get: vi.fn<JobsApi['get']>((over.get ?? (async (id: string) => done(id))) as JobsApi['get']),
  };
}

async function fillSingle(user: ReturnType<typeof userEvent.setup>, days = '14') {
  await user.type(screen.getByLabelText('Job description'), 'Senior Backend Engineer');
  await user.type(screen.getByLabelText('Company website'), 'https://example.com');
  if (days) await user.type(screen.getByLabelText('Days to prepare'), days);
}
const generate = () => screen.getByRole('button', { name: /Generate kit|Starting…/ });
const url = () => window.location.pathname + window.location.search;

describe('single form: checking before sending', () => {
  it('explains every problem, marks the fields, and focuses the first', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<CreateKitPage api={api} />);
    await user.click(generate());
    const jd = screen.getByLabelText('Job description');
    expect(screen.getByText('Paste the job description.')).toBeTruthy();
    expect(screen.getByText(/full address, for example https:\/\/example.com/)).toBeTruthy();
    expect(screen.getByText('Enter a whole number of days from 1 to 60.')).toBeTruthy();
    expect(jd.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('Days to prepare').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(jd);
    expect(api.submit).not.toHaveBeenCalled();
  });

  it.each([['0'], ['61'], ['abc'], ['1.5']])(
    'rejects %s days and focuses the days field',
    async (days) => {
      const api = fakeApi();
      const user = userEvent.setup();
      render(<CreateKitPage api={api} />);
      await fillSingle(user, days);
      await user.click(generate());
      expect(screen.getByText('Enter a whole number of days from 1 to 60.')).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByLabelText('Days to prepare'));
      expect(api.submit).not.toHaveBeenCalled();
    },
  );

  it('sends exactly the API request: trimmed text and days as a number', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<CreateKitPage api={api} />);
    await fillSingle(user, '21');
    await user.click(generate());
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    expect(api.submit).toHaveBeenCalledWith({
      jd: 'Senior Backend Engineer',
      company_url: 'https://example.com',
      days: 21,
    });
  });
});

describe('single form: submitting', () => {
  it('ignores a second submit while the first request is in flight and disables the button', async () => {
    const pending = deferred<SubmitResult>();
    const api = fakeApi({ submit: vi.fn(() => pending.promise) });
    const user = userEvent.setup();
    render(<CreateKitPage api={api} />);
    await fillSingle(user);
    await user.click(generate());
    const busy = await screen.findByRole('button', { name: 'Starting…' });
    expect(busy.hasAttribute('disabled')).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    await user.click(busy);
    await user.type(screen.getByLabelText('Days to prepare'), '{Enter}'); // submit from the keyboard
    expect(api.submit).toHaveBeenCalledTimes(1);
    pending.resolve(queued(ID1));
    expect(await screen.findByText('Your kit is ready.')).toBeTruthy();
    expect(api.submit).toHaveBeenCalledTimes(1);
  });

  it('shows the job, remembers it in the address, and links to the finished kit', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<CreateKitPage api={api} />);
    await fillSingle(user);
    await user.click(generate());
    expect(await screen.findByText('Your kit is ready.')).toBeTruthy();
    expect(url()).toBe(`/kits/new?job=${ID1}`);
    expect(screen.getByRole('link', { name: 'Open kit' }).getAttribute('href')).toBe(
      `/kits/${KIT}`,
    );
    expect(screen.queryByLabelText('Job description')).toBeNull();
  });

  it('says so when an identical request is already running, and follows that job', async () => {
    const api = fakeApi({ submit: vi.fn(async () => ({ ...queued(ID1), deduplicated: true })) });
    const user = userEvent.setup();
    render(<CreateKitPage api={api} />);
    await fillSingle(user);
    await user.click(generate());
    expect(await screen.findByText(/identical request is already being generated/)).toBeTruthy();
    await screen.findByText('Your kit is ready.');
  });

  it('starts over on request, with an empty form and a clean address', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<CreateKitPage api={api} />);
    await fillSingle(user);
    await user.click(generate());
    await screen.findByText('Your kit is ready.');
    await user.click(screen.getByRole('button', { name: 'Create another kit' }));
    expect((screen.getByLabelText('Job description') as HTMLTextAreaElement).value).toBe('');
    expect(url()).toBe('/kits/new');
  });
});

describe('single form: when the request fails', () => {
  async function failWith(error: unknown) {
    const api = fakeApi({
      submit: vi.fn(async () => {
        throw error;
      }),
    });
    const user = userEvent.setup();
    render(<CreateKitPage api={api} />);
    await fillSingle(user);
    await user.click(generate());
    return { api, user };
  }

  it('keeps what was typed, shows the problem, and allows another try', async () => {
    const { api, user } = await failWith(
      new ApiError(
        0,
        'NETWORK_ERROR',
        'Could not reach the server. Check your connection and try again.',
      ),
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Could not reach the server/);
    expect(document.activeElement).toBe(alert);
    expect((screen.getByLabelText('Job description') as HTMLTextAreaElement).value).toBe(
      'Senior Backend Engineer',
    );
    expect(generate().hasAttribute('disabled')).toBe(false);
    api.submit.mockResolvedValueOnce(queued(ID1));
    await user.click(generate());
    expect(await screen.findByText('Your kit is ready.')).toBeTruthy();
  });

  it('puts server field errors on the fields', async () => {
    await failWith(
      new ApiError(400, 'VALIDATION_ERROR', 'Invalid', [{ path: 'company_url', message: 'bad' }]),
    );
    expect(await screen.findByText(/full address, for example/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Company website'));
  });

  it('asks to wait when rate limited', async () => {
    await failWith(new ApiError(429, 'RATE_LIMITED', 'x'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Wait a moment/);
  });

  it('never shows the text of an unexpected error', async () => {
    await failWith(new Error('secret internal detail'));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
  });
});

describe('recovering after a reload', () => {
  it('follows the job named in the address instead of showing the form', async () => {
    resetNavigation('/kits/new', `?job=${ID1}`);
    const api = fakeApi();
    render(<CreateKitPage api={api} />);
    expect(await screen.findByText('Your kit is ready.')).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith(ID1, expect.anything());
    expect(api.submit).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Job description')).toBeNull();
  });

  it('shows a failed job from before the reload as a failure', async () => {
    resetNavigation('/kits/new', `?job=${ID1}`);
    const api = fakeApi({
      get: vi.fn(async () =>
        job({ id: ID1, status: 'failed', error: { code: 'LLM_TIMEOUT', message: 'x' } }),
      ),
    });
    render(<CreateKitPage api={api} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/took too long to answer/);
  });

  it('ignores a malformed job id and shows the form, saying so', () => {
    resetNavigation('/kits/new', '?job=../../etc/passwd');
    const api = fakeApi();
    render(<CreateKitPage api={api} />);
    expect(screen.getByLabelText('Job description')).toBeTruthy();
    expect(screen.getByText(/not valid and was ignored/)).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('follows several jobs from a batch link, each by position', async () => {
    resetNavigation('/kits/new', `?jobs=${ID1},${ID2}`);
    const api = fakeApi();
    render(<CreateKitPage api={api} />);
    expect(await screen.findByText('Job 1 of 2')).toBeTruthy();
    expect(screen.getByText('Job 2 of 2')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('Your kit is ready.')).toHaveLength(2));
    expect(screen.getByText(/Case names are not kept after a reload/)).toBeTruthy();
  });

  it('parses job ids safely', () => {
    const get = (q: string) => jobIdsFromParams(new URLSearchParams(q));
    expect(get('')).toEqual({ single: null, many: [], ignored: false });
    expect(get(`jobs=${ID1},${ID1},${ID2}`).many).toEqual([ID1, ID2]);
    expect(get(`jobs=${ID1},nope`)).toMatchObject({ many: [ID1], ignored: true });
    expect(get(`job=${'A'.repeat(24)}`)).toMatchObject({ single: null, ignored: true });
    expect(
      get(`jobs=${Array.from({ length: 30 }, (_, i) => String(i).padStart(24, '0')).join(',')}`)
        .many,
    ).toHaveLength(10);
  });
});

// ---- several roles from a file ------------------------------------------------------------

const caseOf = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  jd: 'Backend Engineer',
  company_url: 'https://example.com',
  days: 7,
  ...over,
});
const jsonFile = (value: unknown, name = 'cases.json') =>
  new File([typeof value === 'string' ? value : JSON.stringify(value)], name, {
    type: 'application/json',
  });

async function openBatch(api = fakeApi()) {
  const user = userEvent.setup();
  render(<CreateKitPage api={api} />);
  await user.click(screen.getByRole('radio', { name: 'Several roles from a file' }));
  return { api, user, input: () => screen.getByLabelText('Cases file (JSON)') as HTMLInputElement };
}

describe('batch upload: reading the file', () => {
  it('separates a file-level problem from case problems: invalid JSON is one clear message, no case list', async () => {
    const { user, input } = await openBatch();
    await user.upload(input(), jsonFile('{"id": '));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/cases\.json cannot be used/);
    expect(alert.textContent).toMatch(/not valid JSON/);
    expect(screen.queryByRole('region', { name: 'Cases in the file' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Generate \d/ })).toBeNull();
  });

  it.each([
    ['an object instead of a list', '{"id":"a"}', /JSON list/],
    ['an empty list', '[]', /list is empty/],
  ])('rejects %s as a file problem', async (_n, text, message) => {
    const { user, input } = await openBatch();
    await user.upload(input(), jsonFile(text));
    expect((await screen.findByRole('alert')).textContent).toMatch(message);
  });

  it('shows each case with its own verdict, counts honestly, and offers to generate only the valid ones', async () => {
    const { user, input } = await openBatch();
    await user.upload(
      input(),
      jsonFile([
        caseOf('ok-1'),
        caseOf('bad-days', { days: 99 }),
        caseOf('ok-2'),
        caseOf('bad-url', { company_url: 'x' }),
      ]),
    );
    const region = await screen.findByRole('region', { name: 'Cases in the file' });
    expect(within(region).getByText('2 cases are ready, 2 have problems.')).toBeTruthy();
    const items = within(region)
      .getAllByRole('listitem')
      .filter((li) => li.parentElement === region.querySelector('ul'));
    expect(items).toHaveLength(4);
    expect(items[0]?.textContent).toMatch(/ok-1.*Ready to generate/);
    expect(items[1]?.textContent).toMatch(/bad-days.*days must be a whole number from 1 to 60/);
    expect(items[3]?.textContent).toMatch(/bad-url.*company_url must be a full http/);
    expect(within(region).getByText(/cases with problems will not be generated/)).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Generate 2 kits' })).toBeTruthy();
  });

  it('a file with no valid case offers nothing to generate', async () => {
    const { user, input } = await openBatch();
    await user.upload(input(), jsonFile([caseOf('a', { days: 0 }), caseOf('a')]));
    const button = await screen.findByRole('button', { name: 'No valid cases to generate' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getAllByText(/id "a" is used by more than one case/)).toHaveLength(2);
  });

  it('refuses an oversized file before reading it', async () => {
    const { user, input } = await openBatch();
    const big = new File(['x'], 'big.json', { type: 'application/json' });
    Object.defineProperty(big, 'size', { value: 2_000_000 });
    await user.upload(input(), big);
    expect((await screen.findByRole('alert')).textContent).toMatch(/larger than 1 MB/);
  });

  it('replaces the previous result when another file is chosen', async () => {
    const { user, input } = await openBatch();
    await user.upload(input(), jsonFile('nope', 'a.json'));
    await screen.findByRole('alert');
    await user.upload(input(), jsonFile([caseOf('fine')], 'b.json'));
    expect(await screen.findByRole('button', { name: 'Generate 1 kit' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('batch upload: generating', () => {
  it('submits only the valid cases, one at a time, each after the previous finished, with their own data', async () => {
    const order: string[] = [];
    const finished = new Set<string>();
    const get = vi.fn(async (id: string) => {
      finished.add(id);
      return done(id);
    });
    const ids = [ID1, ID2];
    const submit = vi.fn(async (req: { jd: string }) => {
      // the previous job must already have been seen finished before the next is submitted
      order.push(`submit:${req.jd}:${finished.size}`);
      return queued(ids.shift()!);
    });
    const { user, input } = await openBatch(fakeApi({ submit, get }));
    await user.upload(
      input(),
      jsonFile([
        caseOf('one', { jd: 'JD one' }),
        caseOf('bad', { days: 0 }),
        caseOf('two', { jd: 'JD two', days: 30 }),
      ]),
    );
    await user.click(await screen.findByRole('button', { name: 'Generate 2 kits' }));

    await waitFor(() => expect(screen.getAllByText('Your kit is ready.')).toHaveLength(2));
    expect(order).toEqual(['submit:JD one:0', 'submit:JD two:1']);
    expect(submit).toHaveBeenNthCalledWith(2, {
      jd: 'JD two',
      company_url: 'https://example.com',
      days: 30,
    });
    expect(screen.getByText('one')).toBeTruthy();
    expect(screen.getByText('two')).toBeTruthy();
    expect(screen.queryByText('bad')).toBeNull(); // the invalid case was never submitted
    expect(await screen.findByText(/2 of 2 finished/)).toBeTruthy();
    expect(url()).toBe(`/kits/new?jobs=${ID1},${ID2}`);
  });

  it('keeps going after a case fails, and reports it as failed, not as ready', async () => {
    const get = vi.fn(async (id: string) =>
      id === ID1
        ? job({ id, status: 'failed', error: { code: 'COMPANY_UNREACHABLE', message: 'x' } })
        : done(id),
    );
    const { user, input } = await openBatch(fakeApi({ get }));
    await user.upload(input(), jsonFile([caseOf('a'), caseOf('b')]));
    await user.click(await screen.findByRole('button', { name: 'Generate 2 kits' }));
    await waitFor(() => expect(screen.getAllByText('Your kit is ready.')).toHaveLength(1));
    expect(screen.getByRole('alert').textContent).toMatch(/website could not be reached/);
    expect(await screen.findByText(/2 of 2 finished/)).toBeTruthy();
  });

  it('stops the queue when a case cannot be started, says which, and resumes on retry', async () => {
    const ids = [ID1, ID2];
    const submit = vi
      .fn()
      .mockImplementationOnce(async () => queued(ids.shift()!))
      .mockRejectedValueOnce(
        new ApiError(
          0,
          'NETWORK_ERROR',
          'Could not reach the server. Check your connection and try again.',
        ),
      )
      .mockImplementation(async () => queued(ids.shift()!));
    const { user, input } = await openBatch(fakeApi({ submit }));
    await user.upload(input(), jsonFile([caseOf('a'), caseOf('b'), caseOf('c')]));
    await user.click(await screen.findByRole('button', { name: 'Generate 3 kits' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Could not start b/);
    expect(alert.textContent).toMatch(/remaining cases have not been started/);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/could not be started/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getAllByText('Your kit is ready.')).toHaveLength(3));
    expect(submit).toHaveBeenCalledTimes(4); // a, b (failed), b (retry), c
  });

  it('does not double-submit the first case when the button is clicked repeatedly', async () => {
    const pending = deferred<SubmitResult>();
    const submit = vi.fn(() => pending.promise);
    const { user, input } = await openBatch(fakeApi({ submit }));
    await user.upload(input(), jsonFile([caseOf('a')]));
    const button = await screen.findByRole('button', { name: 'Generate 1 kit' });
    await user.dblClick(button);
    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
