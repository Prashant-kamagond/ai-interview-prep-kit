// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegenerationReport, ResearchSnapshot } from '@trao/contracts';
import { ApiError } from '../../lib/api/client';
import type { JobView } from '../../lib/api/jobs';
import { RegenerationInProgress, RegenerationRefused } from '../../lib/api/regeneration';
import { deferred, fakeServer, makeResponse, networkError } from '../../test/builder';
import { job } from '../../test/jobs';
import { BuilderEditor } from './BuilderEditor';
import type { DraftStorage } from './store';

afterEach(cleanup);

const ID = 'a'.repeat(24);
const JOB_ID = 'b'.repeat(24);

const STORED: ResearchSnapshot = {
  status: 'available',
  captured_at: '2026-03-01T10:00:00.000Z',
  company_url: 'https://acme.example/',
  company_name: 'Acme Corp',
  crawl_status: 'ok',
  pages: [
    {
      url: 'https://acme.example/',
      title: 'Acme',
      description: '',
      role: 'home',
      depth: 0,
      text: 'Acme builds payment infrastructure for online merchants.',
      interview_mentions: [],
      fetched_at: '2026-03-01T10:00:00.000Z',
    },
  ],
  discussion: {
    provider: 'hn',
    status: 'no_results',
    retrieved_at: '2026-03-01T10:00:00.000Z',
    items: [],
  },
};

const REPORT: RegenerationReport = {
  section: 'questions',
  category: 'technical',
  kept: ['q3'],
  replaced: ['q1'],
  added: ['q5', 'q6'],
  skipped: [
    {
      reason: 'tombstone',
      detail: '"Explain the event loop" was deleted earlier and is not brought back.',
    },
  ],
  days: null,
  gaps: { uncovered_must_ids: ['r4'], uncovered_ids: ['r4'] },
};

const memory = (): DraftStorage => ({ read: () => null, write: () => undefined });

const succeeded = (report: RegenerationReport | null = REPORT): JobView =>
  job({
    id: JOB_ID,
    kind: 'regenerate',
    status: 'succeeded',
    stage: 'done',
    progress: 100,
    kit_id: ID,
    report,
  });
const failed = (code: string, message = 'x'): JobView =>
  job({ id: JOB_ID, kind: 'regenerate', status: 'failed', error: { code, message } });
const running = (): JobView =>
  job({ id: JOB_ID, kind: 'regenerate', status: 'running', stage: 'generating', progress: 40 });

/**
 * The editor with a fake server, and a regeneration API/jobs API the test scripts. `onStart` runs when a
 * regeneration is accepted and may change the server's kit, like the real job does.
 */
function open(
  options: {
    research?: ResearchSnapshot;
    start?: () => Promise<{ job: JobView; deduplicated: boolean }>;
    onStart?: (server: ReturnType<typeof fakeServer>) => void;
    jobs?: () => Promise<JobView>;
  } = {},
) {
  const server = fakeServer(
    makeResponse(undefined, options.research ? { research: options.research } : {}),
  );
  const start = vi.fn(
    options.start ??
      (async () => {
        options.onStart?.(server);
        return {
          job: job({ id: JOB_ID, kind: 'regenerate', status: 'queued' }),
          deduplicated: false,
        };
      }),
  );
  const jobsGet = vi.fn(options.jobs ?? (async () => succeeded()));
  const api = { get: vi.fn(async () => server.doc), applyOperations: server.api.applyOperations };
  const user = userEvent.setup();
  render(
    <BuilderEditor
      id={ID}
      api={api}
      drafts={memory()}
      debounceMs={20}
      regenerationApi={{ start }}
      jobsApi={{ get: jobsGet }}
    />,
  );
  return { server, start, jobsGet, user, api };
}

const panel = async () =>
  within(await screen.findByRole('region', { name: 'Regenerate a section' }));
const startButton = async (name: string | RegExp) => (await panel()).getByRole('button', { name });
const card = async (title: string) =>
  within((await panel()).getByRole('heading', { name: title }).closest('li')!);
const saved = () => screen.findByText('All changes saved');

describe('what each regeneration needs, before anything is submitted', () => {
  it('lists the three sections with their source requirements', async () => {
    open({ research: STORED });
    const p = await panel();
    expect(p.getByRole('heading', { name: 'Company brief' })).toBeTruthy();
    expect(p.getByRole('heading', { name: 'Questions, one category' })).toBeTruthy();
    expect(p.getByRole('heading', { name: 'Schedule' })).toBeTruthy();
    expect(
      (await card('Company brief')).getByText(/at least one page with readable text/),
    ).toBeTruthy();
    expect(
      (await card('Schedule')).getByText(/only the current kit. No model is used/),
    ).toBeTruthy();
    expect((await card('Questions, one category')).getByText(/not required/)).toBeTruthy();
    expect(p.queryByRole('note')).toBeNull(); // with research stored nothing is flagged
  });

  it('for a kit without stored research says why the brief and company-fit questions are unavailable', async () => {
    const { user } = open(); // research: unavailable
    const brief = await card('Company brief');
    expect(brief.getByRole('note').textContent).toMatch(/not kept/);
    expect(brief.getByRole('note').textContent).toMatch(/never reconstructed/);
    expect((await card('Schedule')).queryByRole('note')).toBeNull();
    // company-fit shows the same, technical does not
    const questions = await card('Questions, one category');
    expect(questions.queryByRole('note')).toBeNull();
    await user.selectOptions(questions.getByRole('combobox', { name: 'Category' }), 'company-fit');
    expect((await card('Questions, one category')).getByRole('note').textContent).toMatch(
      /not kept/,
    );
  });
});

describe('starting a regeneration', () => {
  it('starts the schedule, follows the job, shows the report and refreshes the editor', async () => {
    const report: RegenerationReport = {
      ...REPORT,
      section: 'schedule',
      category: null,
      kept: [],
      replaced: [],
      added: [],
      skipped: [],
      days: { kept: [2], reallocated: [1, 3] },
      gaps: { uncovered_must_ids: [], uncovered_ids: [] },
    };
    const { user, start } = open({
      onStart: (server) => server.change('Reworked on the server'),
      jobs: async () => succeeded(report),
    });
    await user.click(await startButton('Regenerate schedule'));
    expect(start).toHaveBeenCalledWith(ID, { section: 'schedule' });

    expect(await screen.findByText('Regenerated the schedule')).toBeTruthy();
    const p = await panel();
    expect(p.getByText(/2 days were re-planned, 1 pinned day was kept/)).toBeTruthy();
    expect(p.getByText(/The editor now shows the regenerated kit/)).toBeTruthy();
    expect(p.getByText(/Pinned days kept: 2. Days re-planned: 1, 3/)).toBeTruthy();
    // the editor really shows the server's new version
    expect((await screen.findAllByText('Reworked on the server')).length).toBeGreaterThan(0);
  });

  it('starts one question category and shows kept, replaced, added, skipped and coverage gaps', async () => {
    const { user, start } = open({ research: STORED });
    const questions = await card('Questions, one category');
    await user.selectOptions(questions.getByRole('combobox', { name: 'Category' }), 'behavioural');
    await user.click(await startButton('Regenerate behavioural questions'));
    expect(start).toHaveBeenCalledWith(ID, { section: 'questions', category: 'behavioural' });

    const report = await screen.findByRole('region', { name: 'Regeneration report' });
    const r = within(report);
    expect(r.getByRole('heading', { name: 'Kept (1)' })).toBeTruthy();
    expect(r.getByRole('heading', { name: 'Replaced (1)' })).toBeTruthy();
    expect(r.getByRole('heading', { name: 'Added (2)' })).toBeTruthy();
    expect(r.getByRole('heading', { name: 'Skipped (1)' })).toBeTruthy();
    expect(r.getByText(/Deleted earlier, so not brought back/)).toBeTruthy();
    expect(r.getByRole('heading', { name: 'Coverage gaps (1)' })).toBeTruthy();
    expect(r.getByText(/must-have, not covered/)).toBeTruthy();
    expect(r.getByText(/Operate Kubernetes in production/)).toBeTruthy();
  });

  it('starts the brief when research is stored', async () => {
    const { user, start } = open({
      research: STORED,
      jobs: async () =>
        succeeded({
          ...REPORT,
          section: 'brief',
          category: null,
          kept: [],
          replaced: ['brief'],
          added: [],
          skipped: [],
        }),
    });
    await user.click(await startButton('Regenerate company brief'));
    expect(start).toHaveBeenCalledWith(ID, { section: 'brief' });
    expect(await screen.findByText('Regenerated the company brief')).toBeTruthy();
  });

  it('shows real progress while the job runs, announces it, and turns every start button off', async () => {
    const { user, start } = open({ jobs: async () => running() });
    await user.click(await startButton('Regenerate schedule'));
    const status = await screen.findByText(/Regenerating the schedule: Writing the kit/);
    expect(status.closest('[role="status"]')).toBeTruthy();
    expect(
      ((await screen.findByLabelText('Progress reported by the server')) as HTMLProgressElement)
        .value,
    ).toBe(40);
    for (const name of [
      'Regenerate company brief',
      'Regenerate technical questions',
      'Regenerate schedule',
    ]) {
      expect((await startButton(name)).hasAttribute('disabled')).toBe(true);
    }
    await user.click(await startButton('Regenerate schedule'));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('cannot be started twice by a quick double click', async () => {
    const gate = deferred<{ job: JobView; deduplicated: boolean }>();
    const { user, start } = open({ start: () => gate.promise, jobs: async () => running() });
    const button = await startButton('Regenerate schedule');
    await user.dblClick(button);
    expect(start).toHaveBeenCalledTimes(1);
    gate.resolve({
      job: job({ id: JOB_ID, kind: 'regenerate', status: 'queued' }),
      deduplicated: false,
    });
    await screen.findByText(/Regenerating the schedule/);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('says so when an identical regeneration was already running', async () => {
    const { user } = open({
      start: async () => ({
        job: job({ id: JOB_ID, kind: 'regenerate', status: 'running' }),
        deduplicated: true,
      }),
      jobs: async () => running(),
    });
    await user.click(await startButton('Regenerate schedule'));
    expect(await screen.findByText(/An identical regeneration was already running/)).toBeTruthy();
  });

  it('joins a regeneration the server says is already running for this kit, instead of starting another', async () => {
    const { user, jobsGet } = open({
      start: async () => {
        throw new RegenerationInProgress('Another is running.', JOB_ID);
      },
      jobs: async () => running(),
    });
    await user.click(await startButton('Regenerate schedule'));
    expect(
      await screen.findByText(/Another regeneration for this kit was already running/),
    ).toBeTruthy();
    await waitFor(() => expect(jobsGet).toHaveBeenCalledWith(JOB_ID, expect.anything()));
    expect(await screen.findByText(/Regenerating a section/)).toBeTruthy();
  });
});

describe('refusals and problems at the start', () => {
  it("shows the server's section-specific reason when a source is missing, and creates no job", async () => {
    const { user, jobsGet } = open({
      start: async () => {
        throw new RegenerationRefused(
          'The company brief cannot be regenerated: the research this kit was built from was not kept.',
          'RESEARCH_UNAVAILABLE',
        );
      },
    });
    await user.click(await startButton('Regenerate company brief'));
    const alert = await (await panel()).findByRole('alert');
    expect(alert.textContent).toMatch(/Cannot regenerate the company brief/);
    expect(alert.textContent).toMatch(/research this kit was built from was not kept/);
    expect(jobsGet).not.toHaveBeenCalled();
    expect((await startButton('Regenerate company brief')).hasAttribute('disabled')).toBe(false); // free to try something else
    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect((await panel()).queryByRole('alert')).toBeNull();
  });

  it.each([
    [
      new ApiError(
        0,
        'NETWORK_ERROR',
        'Could not reach the server. Check your connection and try again.',
      ),
      /Could not reach the server/,
    ],
    [new ApiError(401, 'SESSION_EXPIRED', 'x'), /session ended/],
    [new ApiError(500, 'INTERNAL_ERROR', 'secret stack'), /could not be started/],
    [new Error('ECONNREFUSED 10.0.0.5'), /could not be started/],
  ])('shows a start failure safely (%#)', async (error, pattern) => {
    const { user } = open({
      start: async () => {
        throw error;
      },
    });
    await user.click(await startButton('Regenerate schedule'));
    const alert = await (await panel()).findByRole('alert');
    expect(alert.textContent).toMatch(pattern);
    expect(document.body.textContent).not.toMatch(/secret stack|ECONNREFUSED|10\.0\.0\.5/);
  });
});

describe('job failures', () => {
  it.each([
    ['LLM_UNAVAILABLE', /unavailable right now/],
    ['BRIEF_NOT_VERIFIED', /existing brief was kept/],
    ['NO_QUESTIONS_GENERATED', /existing questions were kept/],
    ['REGENERATION_REJECTED', /nothing was changed/],
  ])(
    '%s is explained in plain words, and the kit is said to be unchanged',
    async (code, pattern) => {
      const { user } = open({ jobs: async () => failed(code) });
      await user.click(await startButton('Regenerate schedule'));
      const alert = await screen.findByText(/Could not regenerate the schedule/);
      const text = alert.closest('[role="alert"]')!.textContent!;
      expect(text).toMatch(pattern);
      expect(text).toMatch(/The kit was not changed/);
      expect((await startButton('Regenerate schedule')).hasAttribute('disabled')).toBe(false); // can try again
    },
  );

  it('a version conflict offers to load the current kit, which loads it when nothing is unsaved', async () => {
    const { user, server } = open({
      jobs: async () => failed('VERSION_CONFLICT'),
      onStart: (s) => s.change('Changed by another tab'),
    });
    await user.click(await startButton('Regenerate schedule'));
    const alert = await screen.findByText(/Could not regenerate the schedule/);
    expect(alert.closest('[role="alert"]')!.textContent).toMatch(/Nothing was applied/);
    // the editor was already refreshed or can be: either way the user's choice is explicit
    const load = within(alert.closest('[role="alert"]') as HTMLElement).getByRole('button', {
      name: 'Load the current kit',
    });
    await user.click(load);
    expect((await screen.findAllByText('Changed by another tab')).length).toBeGreaterThan(0);
    expect(server.doc.version).toBe(2);
  });

  it('a check that cannot continue is reported as unknown, not as a result, and the kit is not touched', async () => {
    const { user, server } = open({
      jobs: async () => {
        throw new ApiError(401, 'SESSION_EXPIRED', 'x');
      },
    });
    await user.click(await startButton('Regenerate schedule'));
    const alert = await screen.findByText('Status unknown');
    expect(alert.closest('[role="alert"]')!.textContent).toMatch(/session ended/);
    expect(screen.queryByText(/Regenerated the schedule/)).toBeNull();
    expect(server.doc.version).toBe(1);
  });
});

describe('unsaved edits', () => {
  it('never starts on top of unsaved edits: the user must save first or cancel', async () => {
    const { user, start, server } = open();
    const pinButton = await screen.findByRole('button', { name: 'Pin question q1' });
    server.holdNext(); // keep the autosave from finishing
    await user.click(pinButton);
    await user.click(await startButton('Regenerate schedule'));
    const group = await screen.findByRole('group', {
      name: /Unsaved edits before regenerating the schedule/,
    });
    expect(group.textContent).toMatch(/must be saved first/);
    expect(start).not.toHaveBeenCalled();

    await user.click(within(group).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: /Unsaved edits/ })).toBeNull();
    expect(start).not.toHaveBeenCalled();
    server.release();
    await saved();
  });

  it('"Save, then regenerate" saves the edits first and only then starts, in that order', async () => {
    const order: string[] = [];
    const { user, start, server } = open({ onStart: () => order.push('start') });
    const pinButton = await screen.findByRole('button', { name: 'Pin question q1' });
    server.holdNext();
    await user.click(pinButton);
    await user.click(await startButton('Regenerate schedule'));
    const group = await screen.findByRole('group', { name: /Unsaved edits/ });
    await user.click(within(group).getByRole('button', { name: 'Save, then regenerate' }));
    expect(start).not.toHaveBeenCalled(); // still waiting for the save
    order.push('release');
    server.release();
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['release', 'start']);
    expect(server.doc.builder.questions[0]?.pinned).toBe(true); // the edit reached the server first
    expect(await screen.findByText('Regenerated the schedule')).toBeTruthy();
  });

  it('does not start if the edits cannot be saved, and says so', async () => {
    const { user, start, server } = open();
    const pinButton = await screen.findByRole('button', { name: 'Pin question q1' });
    server.holdNext();
    server.failNext(networkError());
    await user.click(pinButton);
    await user.click(await startButton('Regenerate schedule'));
    const group = await screen.findByRole('group', { name: /Unsaved edits/ });
    await user.click(within(group).getByRole('button', { name: 'Save, then regenerate' }));
    server.release();
    expect(await screen.findByText(/regeneration was not started/)).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Unpin question q1' })).toBeTruthy(); // the edit is still there
  });

  it('is switched off while there is a save problem or a conflict to resolve', async () => {
    const { user, server } = open();
    await screen.findByRole('heading', { level: 1 });
    server.change('Changed elsewhere');
    await user.click(screen.getByRole('button', { name: 'Pin question q1' }));
    await screen.findByText('This kit was changed somewhere else');
    expect((await startButton('Regenerate schedule')).hasAttribute('disabled')).toBe(true);
    expect((await panel()).getByText(/Resolve the save problem or conflict/)).toBeTruthy();
  });

  it('keeps edits made while it ran, shows nothing in their place, and leaves them to the explicit conflict workflow', async () => {
    const gate = deferred<JobView>();
    const { user, server } = open({
      jobs: () => gate.promise,
      onStart: (s) => s.change('Regenerated on the server'),
    });
    await user.click(await startButton('Regenerate schedule'));
    await screen.findByText(/Regenerating the schedule/);
    // the user keeps editing while the job runs
    server.holdNext();
    await user.click(await screen.findByRole('button', { name: 'Pin question q2' }));
    gate.resolve(
      succeeded({
        ...REPORT,
        section: 'schedule',
        category: null,
        kept: [],
        replaced: [],
        added: [],
        skipped: [],
        days: { kept: [], reallocated: [1, 2, 3] },
      }),
    );
    expect(
      await screen.findByText(/still shows your version and your edits are kept/),
    ).toBeTruthy();
    // the user's edit is still on screen, and the regenerated text is NOT silently swapped in
    expect(screen.getByRole('button', { name: 'Unpin question q2' })).toBeTruthy();
    expect(screen.queryByText('Regenerated on the server')).toBeNull();
    server.release();
    // saving it meets the ordinary conflict, with the regenerated kit offered, nothing replayed
    expect(await screen.findByText('This kit was changed somewhere else')).toBeTruthy();
  });
});

describe('accessibility of the panel', () => {
  it('uses real buttons, a labelled category control, and announces progress politely', async () => {
    const { user } = open({ jobs: async () => running() });
    const p = await panel();
    expect(p.getByRole('combobox', { name: 'Category' })).toBeTruthy();
    for (const button of p.getAllByRole('button')) expect(button.tagName).toBe('BUTTON');
    const brief = p.getByRole('button', { name: 'Regenerate schedule' });
    brief.focus();
    await user.keyboard('{Enter}');
    const progress = await screen.findByText(/Regenerating the schedule/);
    expect(progress.closest('[role="status"]')).toBeTruthy();
  });

  it('the regenerate section is reachable from the page navigation', async () => {
    open();
    const nav = await screen.findByRole('navigation', { name: 'On this page' });
    const link = within(nav).getByRole('link', { name: 'Regenerate' });
    expect(link.getAttribute('href')).toBe('#regeneration-section-heading');
    expect(document.getElementById('regeneration-section-heading')).not.toBeNull();
  });
});
