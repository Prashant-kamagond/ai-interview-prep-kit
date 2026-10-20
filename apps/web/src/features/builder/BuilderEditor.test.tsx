// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BuilderOperation } from '@trao/contracts';
import { ApiError } from '../../lib/api/client';
import { edit, fakeServer, makeResponse, networkError } from '../../test/builder';
import { BuilderEditor } from './BuilderEditor';
import type { DraftStorage } from './store';

afterEach(cleanup);

const ID = 'a'.repeat(24);

function memoryDrafts(initial: unknown[] | null = null) {
  let stored = initial;
  const drafts: DraftStorage = {
    read: () => stored,
    write: (_id, ops) => {
      stored = ops.length > 0 ? ops : null;
    },
  };
  return {
    drafts,
    get stored() {
      return stored;
    },
  };
}

function open(server = fakeServer(), drafts = memoryDrafts()) {
  const api = { get: vi.fn(async () => server.doc), applyOperations: server.api.applyOperations };
  const user = userEvent.setup();
  render(<BuilderEditor id={ID} api={api} drafts={drafts.drafts} debounceMs={20} />);
  return { server, user, api, drafts };
}

const region = async (name: string | RegExp) => within(await screen.findByRole('region', { name }));
const questions = () => screen.findByRole('region', { name: /^Questions/ }).then((r) => within(r));
const saved = () => screen.findByText('All changes saved');
const button = (name: string | RegExp) => screen.getByRole('button', { name });

describe('loading', () => {
  it('shows a loading status, then the editor with every section and the save state', async () => {
    const server = fakeServer();
    const api = {
      get: vi.fn(() => new Promise<never>(() => undefined)),
      applyOperations: server.api.applyOperations,
    };
    render(<BuilderEditor id={ID} api={api} drafts={memoryDrafts().drafts} />);
    expect(screen.getByRole('status').textContent).toMatch(/Loading your kit/);
    cleanup();

    open();
    expect(await screen.findByRole('heading', { level: 1, name: /Acme Corp/ })).toBeTruthy();
    for (const name of [
      'Company brief',
      'Role and requirements',
      /^Questions \(4\)/,
      /^Flashcards \(1\)/,
      'Preparation schedule',
      'Coverage',
    ]) {
      expect(screen.getByRole('region', { name })).toBeTruthy();
    }
    expect(screen.getByText('All changes saved')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Back to your kits/ }).getAttribute('href')).toBe(
      '/kits',
    );
  });

  it('says not found for a 404 and for an address that cannot be a kit, without asking the API', async () => {
    const get = vi.fn(async () => {
      throw new ApiError(404, 'NOT_FOUND', 'x');
    });
    render(
      <BuilderEditor
        id={ID}
        api={{ get, applyOperations: vi.fn() }}
        drafts={memoryDrafts().drafts}
      />,
    );
    expect(await screen.findByRole('heading', { name: 'Kit not found' })).toBeTruthy();
    cleanup();
    const never = vi.fn();
    render(
      <BuilderEditor
        id="../x"
        api={{ get: never, applyOperations: vi.fn() }}
        drafts={memoryDrafts().drafts}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Kit not found' })).toBeTruthy();
    expect(never).not.toHaveBeenCalled();
  });

  it('on an ended session shows that, with no retry; on other failures offers a retry', async () => {
    render(
      <BuilderEditor
        id={ID}
        api={{
          get: async () => {
            throw new ApiError(401, 'SESSION_EXPIRED', 'x');
          },
          applyOperations: vi.fn(),
        }}
        drafts={memoryDrafts().drafts}
      />,
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(/Your session ended/);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    cleanup();

    const user = userEvent.setup();
    const server = fakeServer();
    const get = vi.fn().mockRejectedValueOnce(networkError()).mockResolvedValueOnce(server.doc);
    render(
      <BuilderEditor
        id={ID}
        api={{ get, applyOperations: server.api.applyOperations }}
        drafts={memoryDrafts().drafts}
      />,
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not reach the server/);
    await user.click(button('Try again'));
    expect(await screen.findByRole('heading', { level: 1, name: /Acme Corp/ })).toBeTruthy();
  });

  it('refuses a kit that fails validation', async () => {
    const bad = new ApiError(200, 'BAD_RESPONSE', 'internal');
    render(
      <BuilderEditor
        id={ID}
        api={{
          get: async () => {
            throw bad;
          },
          applyOperations: vi.fn(),
        }}
        drafts={memoryDrafts().drafts}
      />,
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not read, so it is not shown/);
    expect(alert.textContent).not.toMatch(/internal/);
  });
});

describe('questions', () => {
  it('edits a question: shown at once, marked Edited, saved after the pause, and the server has it', async () => {
    const { user, server } = open();
    await user.click(await screen.findByRole('button', { name: 'Edit question q1' }));
    const form = within(screen.getByRole('form', { name: 'Edit question q1' }));
    const box = form.getByRole('textbox', { name: 'Question' });
    await user.clear(box);
    await user.type(box, 'A better question');
    server.holdNext(); // the network is stuck: the edit must still show
    await user.click(form.getByRole('button', { name: 'Apply changes' }));

    const q = await questions();
    expect(q.getByText('A better question')).toBeTruthy();
    expect(screen.queryByText('All changes saved')).toBeNull();
    server.release();
    await saved();
    expect(server.doc.kit.questions[0]?.prompt).toBe('A better question');
    expect(server.calls).toEqual([
      { version: 1, operations: [expect.objectContaining({ type: 'edit_question', id: 'q1' })] },
    ]);
    expect((await questions()).getAllByText('Edited')).toHaveLength(1);
  });

  it('sends only the fields that changed, and nothing when nothing changed', async () => {
    const { user, server } = open();
    await user.click(await screen.findByRole('button', { name: 'Edit question q1' }));
    await user.click(
      within(screen.getByRole('form', { name: 'Edit question q1' })).getByRole('button', {
        name: 'Apply changes',
      }),
    );
    expect(screen.queryByRole('form', { name: 'Edit question q1' })).toBeNull();
    expect(screen.getByText('All changes saved')).toBeTruthy();

    await user.click(button('Edit question q1'));
    const form = within(screen.getByRole('form', { name: 'Edit question q1' }));
    await user.selectOptions(form.getByRole('combobox', { name: 'Difficulty' }), '3');
    await user.click(form.getByRole('button', { name: 'Apply changes' }));
    await saved();
    expect(server.calls[0]?.operations).toEqual([
      { type: 'edit_question', id: 'q1', changes: { difficulty: 3 } },
    ]);
  });

  it('refuses an empty question text with a message on the field', async () => {
    const { user, server } = open();
    await user.click(await screen.findByRole('button', { name: 'Edit question q1' }));
    const form = within(screen.getByRole('form', { name: 'Edit question q1' }));
    await user.clear(form.getByRole('textbox', { name: 'Question' }));
    await user.click(form.getByRole('button', { name: 'Apply changes' }));
    expect(form.getByText('Write the question.')).toBeTruthy();
    expect(server.calls).toHaveLength(0);
  });

  it('moves a question to another category through the edit form', async () => {
    const { user, server } = open();
    await user.click(await screen.findByRole('button', { name: 'Edit question q1' }));
    const form = within(screen.getByRole('form', { name: 'Edit question q1' }));
    await user.selectOptions(form.getByRole('combobox', { name: 'Category' }), 'behavioural');
    await user.click(form.getByRole('button', { name: 'Apply changes' }));
    const q = await questions();
    const group = within(q.getByRole('heading', { name: /^Behavioural/ }).parentElement!);
    expect(group.getByText('How do you version a REST API?')).toBeTruthy();
    expect(q.getByRole('heading', { name: 'Behavioural (2)' })).toBeTruthy();
    await saved();
    expect(server.doc.kit.questions[0]?.category).toBe('behavioural');
  });

  it('changes which requirements a question tests, and the coverage summary follows', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Edit question q4' }));
    const form = within(screen.getByRole('form', { name: 'Edit question q4' }));
    await user.click(form.getByRole('checkbox', { name: /r4 Operate Kubernetes/ }));
    await user.click(form.getByRole('button', { name: 'Apply changes' }));
    const coverage = await region('Coverage');
    expect(coverage.getByText('4 of 4 requirements are covered.')).toBeTruthy();
    expect(coverage.getByText('The kit reports no uncovered requirements.')).toBeTruthy();
    await saved();
  });

  it('adds a question: placed in its category, marked Added by you, on the chosen day, and saved', async () => {
    const { user, server } = open();
    await user.click(await screen.findByRole('button', { name: 'Add a question' }));
    const form = within(screen.getByRole('form', { name: 'Add a question' }));
    await user.type(form.getByRole('textbox', { name: 'Question' }), 'Why do you want this job?');
    await user.selectOptions(form.getByRole('combobox', { name: 'Category' }), 'company-fit');
    await user.selectOptions(form.getByRole('combobox', { name: 'Day' }), '3');
    await user.click(form.getByRole('button', { name: 'Add question' }));

    const q = await questions();
    const group = within(q.getByRole('heading', { name: /^Company fit/ }).parentElement!);
    expect(group.getByText('Why do you want this job?')).toBeTruthy();
    expect(group.getByText('Added by you')).toBeTruthy();
    const schedule = await region('Preparation schedule');
    expect(
      within(schedule.getByRole('heading', { name: /^Day 3/ }).parentElement!).getByText(
        /Why do you want this job\?/,
      ),
    ).toBeTruthy();
    await saved();
    expect(server.doc.kit.questions.at(-1)).toMatchObject({
      id: 'q5',
      prompt: 'Why do you want this job?',
    });
    expect(server.doc.kit.schedule.days[2]?.question_ids).toEqual(['q5']);
  });

  it('asks before deleting, defaults to Cancel, and shows the resulting coverage gap after a confirmed delete', async () => {
    const { user, server } = open();
    await screen.findByRole('heading', { level: 1 });
    await user.click(button('Delete question q2'));
    const confirm = within(screen.getByRole('group', { name: 'Confirm deleting question q2' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(confirm.getByRole('button', { name: 'Cancel' })),
    );
    await user.click(confirm.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: /Confirm deleting/ })).toBeNull();
    expect(server.calls).toHaveLength(0);

    await user.click(button('Delete question q2'));
    await user.click(
      within(screen.getByRole('group', { name: 'Confirm deleting question q2' })).getByRole(
        'button',
        { name: 'Yes, delete' },
      ),
    );
    const coverage = await region('Coverage');
    expect(coverage.getByText('2 of 4 requirements are covered; 2 not covered.')).toBeTruthy();
    expect(coverage.getAllByText(/Communicate with stakeholders/).length).toBeGreaterThan(0);
    const q = await questions();
    expect(q.queryByText(/Tell me about a disagreement/)).toBeNull();
    expect(q.queryByRole('heading', { name: /^Behavioural/ })).toBeNull(); // its only question is gone
    await saved();
    expect(server.doc.kit.questions.map((x) => x.id)).toEqual(['q1', 'q3', 'q4']);
    expect(server.doc.builder.tombstones).toHaveLength(1);
  });

  it('reorders with keyboard-operable buttons, announces it, and disables the ends', async () => {
    const kit = makeResponse().kit;
    // two technical questions so there is something to reorder within a category
    const extra = {
      ...kit,
      questions: [...kit.questions, { ...kit.questions[0]!, id: 'q5', prompt: 'Second technical' }],
      schedule: {
        ...kit.schedule,
        days: kit.schedule.days.map((d, i) =>
          i === 2 ? { ...d, question_ids: ['q5'], minutes: 15 } : d,
        ),
      },
    };
    const { user, server } = open(fakeServer(makeResponse(extra)));
    await screen.findByRole('heading', { level: 1 });
    expect(button('Move question q1 up').hasAttribute('disabled')).toBe(true);
    expect(button('Move question q5 down').hasAttribute('disabled')).toBe(true);
    button('Move question q1 down').focus();
    await user.keyboard('{Enter}');
    const technical = within(
      (await questions()).getByRole('heading', { name: /^Technical/ }).parentElement!,
    );
    expect(
      technical.getAllByRole('listitem').filter((li) => li.querySelector('code'))[0]?.textContent,
    ).toMatch(/Second technical/);
    expect(screen.getByText('Moved question q1 down')).toBeTruthy();
    await saved();
    expect(server.doc.kit.questions.map((q) => q.id)).toEqual(['q2', 'q3', 'q4', 'q5', 'q1']);
  });

  it('pins and unpins with a toggle button that reports its state', async () => {
    const { user, server } = open();
    const pin = await screen.findByRole('button', { name: 'Pin question q1' });
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    await user.click(pin);
    expect(
      screen.getByRole('button', { name: 'Unpin question q1' }).getAttribute('aria-pressed'),
    ).toBe('true');
    await saved();
    expect(server.doc.builder.questions[0]).toMatchObject({
      id: 'q1',
      pinned: true,
      edited: false,
    });
    await user.click(screen.getByRole('button', { name: 'Unpin question q1' }));
    await saved();
    expect(server.doc.builder.questions[0]?.pinned).toBe(false);
  });
});

describe('flashcards, brief and requirements', () => {
  it('edits, adds and deletes flashcards', async () => {
    const { user, server } = open();
    await user.click(await screen.findByRole('button', { name: 'Edit flashcard f1' }));
    let form = within(screen.getByRole('form', { name: 'Edit flashcard f1' }));
    const back = form.getByRole('textbox', { name: 'Back' });
    await user.clear(back);
    await user.type(back, 'Same effect, however often.');
    await user.click(form.getByRole('button', { name: 'Apply changes' }));
    const cards = await region(/^Flashcards/);
    expect(cards.getByText('Same effect, however often.')).toBeTruthy();

    await user.click(button('Add a flashcard'));
    form = within(screen.getByRole('form', { name: 'Add a flashcard' }));
    await user.type(form.getByRole('textbox', { name: 'Front' }), 'What is a saga?');
    await user.click(form.getByRole('button', { name: 'Add flashcard' }));
    expect(
      within(await screen.findByRole('region', { name: /^Flashcards \(2\)/ })).getByText(
        'What is a saga?',
      ),
    ).toBeTruthy();
    await saved();
    expect(server.doc.kit.flashcards.map((f) => f.id)).toEqual(['f1', 'f2']);

    await user.click(button('Delete flashcard f1'));
    await user.click(
      within(screen.getByRole('group', { name: 'Confirm deleting flashcard f1' })).getByRole(
        'button',
        { name: 'Yes, delete' },
      ),
    );
    await waitFor(() => expect(server.doc.kit.flashcards.map((f) => f.id)).toEqual(['f2']));
  });

  it('edits the company brief with Apply disabled until something changes', async () => {
    const { user, server } = open();
    const brief = await region('Company brief');
    const apply = brief.getByRole('button', { name: 'Apply changes' });
    expect(apply.hasAttribute('disabled')).toBe(true);
    const summary = brief.getByRole('textbox', { name: 'Summary' });
    await user.clear(summary);
    await user.type(summary, 'A new summary.');
    expect(apply.hasAttribute('disabled')).toBe(false);
    await user.click(apply);
    await saved();
    expect(server.doc.kit.company_brief.summary).toBe('A new summary.');
    expect(server.doc.builder.brief.edited).toBe(true);
    // the source links stay safe
    expect(brief.getByRole('link', { name: /acme\.example\/careers/ }).getAttribute('rel')).toBe(
      'noopener noreferrer',
    );
    expect(brief.getByText('javascript:alert(1)').closest('a')).toBeNull();
  });

  it('edits, adds and deletes requirements, and flags a requirement no question covers', async () => {
    const { user, server } = open();
    const reqs = await region('Role and requirements');
    expect(reqs.getByText('Not covered by any question')).toBeTruthy();

    await user.click(reqs.getByRole('button', { name: 'Edit requirement r2' }));
    const form = within(screen.getByRole('form', { name: 'Edit requirement r2' }));
    await user.selectOptions(form.getByRole('combobox', { name: 'Priority' }), 'must');
    await user.click(form.getByRole('button', { name: 'Apply changes' }));
    await saved();
    expect(server.doc.kit.role.requirements[1]?.priority).toBe('must');

    await user.click(button('Add a requirement'));
    const add = within(screen.getByRole('form', { name: 'Add a requirement' }));
    await user.type(add.getByRole('textbox', { name: 'Requirement' }), 'Terraform');
    await user.click(add.getByRole('button', { name: 'Add requirement' }));
    expect(
      (await region('Coverage')).getByText('3 of 5 requirements are covered; 2 not covered.'),
    ).toBeTruthy();
    await waitFor(() => expect(server.doc.kit.role.requirements.at(-1)?.id).toBe('r5'));

    await user.click(button('Delete requirement r5'));
    await user.click(
      within(screen.getByRole('group', { name: 'Confirm deleting requirement r5' })).getByRole(
        'button',
        { name: 'Yes, delete' },
      ),
    );
    await waitFor(() =>
      expect(server.doc.kit.role.requirements.map((r) => r.id)).toEqual(['r1', 'r2', 'r3', 'r4']),
    );
    expect(
      (await region('Coverage')).getByText('3 of 4 requirements are covered; 1 not covered.'),
    ).toBeTruthy();
  });
});

describe('schedule', () => {
  const day = async (n: number) => {
    const schedule = await region('Preparation schedule');
    return within(
      schedule.getByRole('heading', { name: new RegExp(`^Day ${n}\\b`) }).closest('li')!,
    );
  };

  it('shows the days, says the number of days is fixed, and labels calculated minutes', async () => {
    open();
    const schedule = await region('Preparation schedule');
    expect(
      schedule.getByText(/3 days, as requested \(the number of days stays fixed\)/),
    ).toBeTruthy();
    expect((await day(1)).getByRole('heading').textContent).toMatch(/calculated/);
    expect((await day(3)).getByText('No questions are scheduled this day.')).toBeTruthy();
  });

  it('moves a question to another day by choosing the day, and recalculates both days', async () => {
    const { user, server } = open();
    const d1 = await day(1);
    await user.selectOptions(d1.getByRole('combobox', { name: 'Move question q1 to' }), '3');
    await user.click(d1.getByRole('button', { name: 'Move question q1 to the chosen day' }));
    expect((await day(3)).getByText(/How do you version a REST API\?/)).toBeTruthy();
    expect(screen.getByText('Moved question q1 to day 3')).toBeTruthy();
    await saved();
    expect(server.doc.kit.schedule.days.map((d) => d.question_ids)).toEqual([
      ['q4'],
      ['q3', 'q2'],
      ['q1'],
    ]);
    // every question is still scheduled exactly once
    expect(server.doc.kit.schedule.days.flatMap((d) => d.question_ids).sort()).toEqual([
      'q1',
      'q2',
      'q3',
      'q4',
    ]);
  });

  it('reorders within a day with Earlier and Later', async () => {
    const { user, server } = open();
    const d1 = await day(1);
    expect(
      d1
        .getByRole('button', { name: 'Move question q1 earlier on day 1' })
        .hasAttribute('disabled'),
    ).toBe(true);
    await user.click(d1.getByRole('button', { name: 'Move question q1 later on day 1' }));
    await saved();
    expect(server.doc.kit.schedule.days[0]?.question_ids).toEqual(['q4', 'q1']);
    expect(screen.getByText('Moved question q1 later on day 1')).toBeTruthy();
  });

  it('edits the focus text, and keeps what the user wrote', async () => {
    const { user, server } = open();
    const d2 = await day(2);
    const focus = d2.getByRole('textbox', { name: 'Focus' });
    await user.clear(focus);
    await user.type(focus, 'Mock interviews');
    await user.click(d2.getByRole('button', { name: 'Save focus' }));
    await saved();
    expect(server.doc.kit.schedule.days[1]?.focus).toBe('Mock interviews');
    expect(server.doc.builder.days[1]).toMatchObject({ focus_manual: true, edited: true });
  });

  it('sets minutes by hand, validates the entry, and can go back to the calculated value', async () => {
    const { user, server } = open();
    let d1 = await day(1);
    const minutes = d1.getByRole('textbox', { name: 'Minutes' });
    await user.clear(minutes);
    await user.type(minutes, 'lots');
    await user.click(d1.getByRole('button', { name: 'Set minutes' }));
    expect(d1.getByText('Enter whole minutes from 0 to 1440.')).toBeTruthy();
    expect(server.calls).toHaveLength(0);

    await user.clear(minutes);
    await user.type(minutes, '90');
    await user.click(d1.getByRole('button', { name: 'Set minutes' }));
    await saved();
    d1 = await day(1);
    expect(d1.getByRole('heading').textContent).toMatch(/90 minutes \(set by you\)/);
    expect(server.doc.kit.schedule.days[0]?.minutes).toBe(90);

    await user.click(d1.getByRole('button', { name: 'Use calculated minutes' }));
    await saved();
    expect((await day(1)).getByRole('heading').textContent).toMatch(/calculated/);
    expect(server.doc.builder.days[0]?.minutes_manual).toBe(false);
  });

  it('pins a day, and the requested length is never changed by any edit', async () => {
    const { user, server } = open();
    await user.click(await screen.findByRole('button', { name: 'Pin day 2' }));
    await saved();
    expect(server.doc.builder.days[1]?.pinned).toBe(true);
    expect(server.doc.kit.schedule.days_available).toBe(3);
    expect(screen.queryByRole('button', { name: /add day|remove day|delete day/i })).toBeNull();
  });
});

describe('saving states and recovery', () => {
  it('shows Saving… while a request is open, and keeps edits made meanwhile', async () => {
    const { user, server } = open();
    const first = await screen.findByRole('button', { name: 'Pin question q1' });
    server.holdNext();
    await user.click(first);
    await waitFor(() => expect(screen.getByText('Saving…')).toBeTruthy());
    // edits while the request is open
    await user.click(button('Pin question q2'));
    await user.click(button('Pin flashcard f1'));
    expect(screen.getByRole('button', { name: 'Unpin question q2' })).toBeTruthy();
    expect(server.calls).toHaveLength(1);
    server.release();
    await saved();
    expect(server.calls).toHaveLength(2);
    expect(server.doc.builder.questions.map((m) => m.pinned)).toEqual([true, true, false, false]);
    expect(server.doc.builder.flashcards[0]?.pinned).toBe(true);
  });

  it('after a failed save keeps the edits, says so, and Retry saves them once', async () => {
    const server = fakeServer();
    server.failNext(networkError());
    const { user } = open(server);
    await user.click(await screen.findByRole('button', { name: 'Pin question q1' }));
    const banner = await screen.findByText('Your changes have not been saved');
    expect(banner.parentElement?.textContent).toMatch(/Could not reach the server/);
    expect(banner.parentElement?.textContent).toMatch(/1 unsaved edit is kept on this page/);
    expect(screen.getByText('Could not save')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unpin question q1' })).toBeTruthy(); // still shown

    await user.click(button('Retry saving'));
    await saved();
    expect(server.calls).toHaveLength(2);
    expect(server.doc.builder.questions[0]?.pinned).toBe(true);
    expect(screen.queryByText('Your changes have not been saved')).toBeNull();
  });

  it('a save that cannot be retried offers only to discard', async () => {
    const server = fakeServer();
    server.failNext(new ApiError(422, 'OPERATION_REJECTED', 'Question "q9" does not exist'));
    const { user } = open(server);
    await user.click(await screen.findByRole('button', { name: 'Pin question q1' }));
    await screen.findByText('Your changes have not been saved');
    expect(screen.queryByRole('button', { name: 'Retry saving' })).toBeNull();
    await user.click(button('Discard my unsaved changes'));
    expect(screen.getByRole('button', { name: 'Pin question q1' })).toBeTruthy();
    expect(screen.getByText('All changes saved')).toBeTruthy();
  });

  it('tells the user when the kit changed elsewhere, pauses editing, and keeps their edits listed', async () => {
    const server = fakeServer();
    const { user } = open(server);
    await screen.findByRole('heading', { level: 1 });
    server.change('Changed by someone else', 'q2');
    await user.click(button('Pin question q1'));
    const alert = await screen.findByText('This kit was changed somewhere else');
    const panel = within(alert.closest('[role="alert"]') as HTMLElement);
    expect(panel.getByText(/now at version 2; your edits were made on version 1/)).toBeTruthy();
    expect(panel.getByText('Pin question q1')).toBeTruthy();
    expect(screen.getByText('Changed elsewhere')).toBeTruthy();
    expect(button('Edit question q1').hasAttribute('disabled')).toBe(true); // paused
    expect(server.calls).toHaveLength(1); // nothing was resent
    await new Promise((r) => setTimeout(r, 120));
    expect(server.calls).toHaveLength(1);
  });

  it("reapplies on request: the other change and the user's edit both end up saved", async () => {
    const server = fakeServer();
    const { user } = open(server);
    await screen.findByRole('heading', { level: 1 });
    server.change('Changed by someone else', 'q2');
    await user.click(button('Pin question q1'));
    await user.click(
      await screen.findByRole('button', { name: 'Reapply my edits to the new version' }),
    );
    await saved();
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]?.version).toBe(2);
    expect(server.doc.kit.questions[1]?.prompt).toBe('Changed by someone else');
    expect(server.doc.builder.questions[0]?.pinned).toBe(true);
    expect(button('Edit question q1').hasAttribute('disabled')).toBe(false);
  });

  it('names the edit that cannot be reapplied and lets the user discard just that one', async () => {
    const server = fakeServer();
    const { user } = open(server);
    const pinQ2 = await screen.findByRole('button', { name: 'Pin question q2' });
    server.apply([{ type: 'delete_question', id: 'q1' }]); // someone else deleted q1
    server.holdNext();
    await user.click(pinQ2);
    await waitFor(() => expect(screen.getByText('Saving…')).toBeTruthy());
    await user.click(button('Pin question q1')); // made while the first save is in flight
    server.release();
    await user.click(
      await screen.findByRole('button', { name: 'Reapply my edits to the new version' }),
    );
    expect(await screen.findByText(/Edit 2 no longer applies/)).toBeTruthy();
    expect(screen.getByText(/Pin question q1 — cannot be applied to the new version/)).toBeTruthy();
    expect(server.calls).toHaveLength(1);

    await user.click(button('Discard that edit and reapply the rest'));
    await saved();
    expect(server.doc.builder.questions.find((m) => m.id === 'q2')?.pinned).toBe(true);
    expect(server.doc.kit.questions.some((q) => q.id === 'q1')).toBe(false);
  });

  it('discarding loads the new version and drops the edits only when asked', async () => {
    const server = fakeServer();
    const { user } = open(server);
    await screen.findByRole('heading', { level: 1 });
    server.change('Changed by someone else', 'q2');
    await user.click(button('Pin question q1'));
    await user.click(
      await screen.findByRole('button', { name: 'Discard my edits and use the new version' }),
    );
    expect(screen.getByText('All changes saved')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pin question q1' })).toBeTruthy(); // the edit is gone
    expect((await questions()).getByText('Changed by someone else')).toBeTruthy();
    expect(server.doc.builder.questions[0]?.pinned).toBe(false);
  });
});

describe('drafts from an earlier visit', () => {
  const draft = [edit('q1', 'From before')] as BuilderOperation[];

  it('offers to restore them, applies them only if they still fit, and then saves them', async () => {
    const mem = memoryDrafts(draft);
    const { user, server } = open(fakeServer(), mem);
    expect(await screen.findByText('You have unsaved edits from an earlier visit')).toBeTruthy();
    await user.click(button('Restore my edits'));
    expect((await questions()).getByText('From before')).toBeTruthy();
    await saved();
    expect(server.doc.kit.questions[0]?.prompt).toBe('From before');
    expect(mem.stored).toBeNull();
    expect(screen.queryByText('You have unsaved edits from an earlier visit')).toBeNull();
  });

  it('discards them on request without touching the kit', async () => {
    const mem = memoryDrafts(draft);
    const { user, server } = open(fakeServer(), mem);
    await user.click(await screen.findByRole('button', { name: 'Discard them' }));
    expect(mem.stored).toBeNull();
    expect(server.calls).toHaveLength(0);
  });

  it('applies none of a draft that no longer fits, and says so', async () => {
    const mem = memoryDrafts([edit('q1', 'ok'), { type: 'delete_question', id: 'gone' }]);
    const { user, server } = open(fakeServer(), mem);
    await user.click(await screen.findByRole('button', { name: 'Restore my edits' }));
    expect(await screen.findByText(/could not be restored/)).toBeTruthy();
    expect(server.calls).toHaveLength(0);
    expect((await questions()).queryByText('ok')).toBeNull();
  });
});

describe('leaving the page', () => {
  it('warns before the browser closes only while there are unsaved edits', async () => {
    const server = fakeServer();
    const { user } = open(server);
    const first = await screen.findByRole('button', { name: 'Pin question q1' });
    server.holdNext();
    await user.click(first);
    await waitFor(() => expect(screen.getByText('Saving…')).toBeTruthy());
    const during = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(during);
    expect(during.defaultPrevented).toBe(true);
    server.release();
    await saved();
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});

describe('keyboard focus is never lost', () => {
  it('returns to the Edit button after applying or cancelling an edit form', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Edit question q1' }));
    const form = within(screen.getByRole('form', { name: 'Edit question q1' }));
    await user.click(form.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit question q1' }));

    await user.click(screen.getByRole('button', { name: 'Edit question q1' }));
    const again = within(screen.getByRole('form', { name: 'Edit question q1' }));
    await user.selectOptions(again.getByRole('combobox', { name: 'Difficulty' }), '3');
    await user.click(again.getByRole('button', { name: 'Apply changes' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit question q1' })),
    );
    await saved();
  });

  it('returns to the Add button when an add form is closed', async () => {
    const { user } = open();
    await user.click(await screen.findByRole('button', { name: 'Add a flashcard' }));
    await user.click(
      within(screen.getByRole('form', { name: 'Add a flashcard' })).getByRole('button', {
        name: 'Cancel',
      }),
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add a flashcard' }));
  });

  it('returns to the Delete button after Cancel, and to the section heading after a confirmed delete', async () => {
    const { user } = open();
    await screen.findByRole('heading', { level: 1 });
    await user.click(screen.getByRole('button', { name: 'Delete question q2' }));
    await user.click(
      within(screen.getByRole('group', { name: 'Confirm deleting question q2' })).getByRole(
        'button',
        { name: 'Cancel' },
      ),
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete question q2' }));

    await user.click(screen.getByRole('button', { name: 'Delete question q2' }));
    await user.click(
      within(screen.getByRole('group', { name: 'Confirm deleting question q2' })).getByRole(
        'button',
        { name: 'Yes, delete' },
      ),
    );
    await waitFor(() => expect(document.activeElement?.id).toBe('questions-section-heading'));
    await saved();
  });

  it('keeps focus with the moved question: on the same control, or the opposite one when it reached the end', async () => {
    const { user } = open();
    const later = await screen.findByRole('button', { name: 'Move question q1 later on day 1' });
    later.focus();
    await user.keyboard('{Enter}'); // q1 is now last on day 1, so "later" is disabled
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Move question q1 earlier on day 1' }),
      ),
    );
    await saved();
  });
});

describe('practice mode link', () => {
  it("the editor links to practising this kit's flashcards", async () => {
    open();
    const link = await screen.findByRole('link', { name: 'Practise flashcards' });
    expect(link.getAttribute('href')).toBe(`/kits/${ID}/practice`);
  });
});
