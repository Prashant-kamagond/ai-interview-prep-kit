// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardProgress, Kit } from '@trao/contracts';
import { ApiError } from '../../lib/api/client';
import type { KitRecord } from '../../lib/api/kits';
import type { PracticeApi } from '../../lib/api/practice';
import { deferred } from '../../test/auth';
import { makeKit, makeRecord } from '../../test/kit';
import { PracticePage } from './PracticePage';

afterEach(cleanup);

const ID = 'a'.repeat(24);
const T0 = '2026-03-01T10:00:00.000Z';

function kitWith(count: number): Kit {
  const kit = makeKit();
  return {
    ...kit,
    flashcards: Array.from({ length: count }, (_, i) => ({
      id: `f${i + 1}`,
      front: `Front ${i + 1}`,
      back: `Back ${i + 1}`,
      requirement_ids: [],
    })),
  };
}
const progressOf = (card_id: string, confidence: 1 | 2 | 3, at = T0): CardProgress => ({
  card_id,
  confidence,
  attempts: 1,
  last_practised_at: at,
});

function setup(
  options: {
    cards?: number;
    progress?: CardProgress[];
    record?: PracticeApi['record'];
    reset?: PracticeApi['reset'];
    kit?: () => Promise<KitRecord>;
  } = {},
) {
  const kit = makeRecord(kitWith(options.cards ?? 3));
  let n = 0;
  const stored = new Map((options.progress ?? []).map((p) => [p.card_id, p]));
  const record = vi.fn<PracticeApi['record']>(
    options.record ??
      (async (_kit, cardId, rating) => {
        const prev = stored.get(cardId);
        const next: CardProgress = {
          card_id: cardId,
          confidence: rating.confidence,
          attempts: (prev?.attempts ?? 0) + 1,
          last_practised_at: new Date(Date.parse(T0) + ++n * 60_000).toISOString(),
        };
        stored.set(cardId, next);
        return next;
      }),
  );
  const reset = vi.fn<PracticeApi['reset']>(options.reset ?? (async () => stored.clear()));
  const progress = vi.fn<PracticeApi['progress']>(async () => ({
    kit_id: ID,
    cards: [...stored.values()],
  }));
  const api: PracticeApi = { progress, record, reset };
  const kitsApi = { get: vi.fn(options.kit ?? (async () => kit)) };
  let a = 0;
  const user = userEvent.setup();
  render(
    <PracticePage
      id={ID}
      kitsApi={kitsApi}
      practiceApi={api}
      makeAttemptId={() => `attempt-${++a}`}
    />,
  );
  return { user, record, reset, progress, kitsApi };
}

const start = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole('button', { name: 'Start practising' }));
const heading = () => screen.getByRole('heading', { level: 2 }).textContent;
const show = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'Show answer' }));
const choose = (user: ReturnType<typeof userEvent.setup>, label: string) =>
  user.click(screen.getByRole('button', { name: new RegExp(`^${label}`) }));

describe('loading and failing', () => {
  it('announces loading, then shows the start screen', async () => {
    const gate = deferred<KitRecord>();
    setup({ kit: () => gate.promise });
    expect(screen.getByRole('status').textContent).toMatch(/Loading your flashcards/);
    gate.resolve(makeRecord(kitWith(2)));
    expect(
      await screen.findByRole('heading', { level: 1, name: /Practise flashcards/ }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start practising' })).toBeTruthy();
  });

  it('says not found for a 404, and for an address that cannot be a kit without asking the API', async () => {
    setup({
      kit: async () => {
        throw new ApiError(404, 'NOT_FOUND', 'x');
      },
    });
    expect(await screen.findByRole('heading', { name: 'Kit not found' })).toBeTruthy();
    cleanup();
    const get = vi.fn();
    render(
      <PracticePage
        id="../x"
        kitsApi={{ get }}
        practiceApi={{ progress: vi.fn(), record: vi.fn(), reset: vi.fn() }}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Kit not found' })).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
  });

  it('on an ended session says so, with no retry', async () => {
    setup({
      kit: async () => {
        throw new ApiError(401, 'SESSION_EXPIRED', 'x');
      },
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(/Your session ended/);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('shows a failure with a retry that loads the session', async () => {
    const kit = makeRecord(kitWith(2));
    const get = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(
          0,
          'NETWORK_ERROR',
          'Could not reach the server. Check your connection and try again.',
        ),
      )
      .mockResolvedValue(kit);
    const { user } = setup({ kit: get });
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not reach the server/);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Start practising' })).toBeTruthy();
  });

  it('shows a kit with no flashcards as an empty state, with nothing to start', async () => {
    setup({ cards: 0 });
    expect(await screen.findByText('This kit has no flashcards')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start practising' })).toBeNull();
    const links = screen.getAllByRole('link', { name: 'Back to the kit' });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.getAttribute('href')).toBe(`/kits/${ID}`);
  });
});

describe('what is covered and what is not (before starting)', () => {
  it('reports coverage and lists the cards not covered yet', async () => {
    setup({ progress: [progressOf('f1', 3)] });
    const coverage = within(await screen.findByLabelText('Coverage'));
    expect(coverage.getByRole('status').textContent).toBe(
      'Covered: 1 of 3 cards; 2 not covered yet.',
    );
    expect(coverage.getByText('Confident: 1')).toBeTruthy();
    expect(coverage.getByText('Cards not covered yet (2)')).toBeTruthy();
    expect(coverage.getByText('Front 2')).toBeTruthy();
    expect(coverage.getByText('Front 3')).toBeTruthy();
    expect(coverage.queryByText('Front 1')).toBeNull();
  });

  it('with no progress nothing is covered; with everything rated it says so', async () => {
    setup();
    expect((await screen.findByLabelText('Coverage')).textContent).toMatch(
      /Covered: 0 of 3 cards; 3 not covered yet/,
    );
    cleanup();
    setup({ progress: [progressOf('f1', 1), progressOf('f2', 2), progressOf('f3', 3)] });
    const coverage = within(await screen.findByLabelText('Coverage'));
    expect(coverage.getByRole('status').textContent).toBe('Covered: 3 of 3 cards.');
    expect(coverage.getByText('Every card has been practised at least once.')).toBeTruthy();
  });
});

describe('a session: one card at a time', () => {
  it('starts with cards never rated, then the least confident, and shows one card with its answer hidden', async () => {
    const { user } = setup({ progress: [progressOf('f1', 3), progressOf('f2', 1)] });
    await start(user);
    expect(heading()).toBe('Front 3'); // never rated
    expect(
      screen.getByRole('progressbar', { hidden: true }) ??
        screen.getByLabelText(/Session progress/),
    ).toBeTruthy();
    expect((screen.getByLabelText(/Session progress/) as HTMLProgressElement).max).toBe(3);
    // exactly one card, no answer, no rating buttons yet
    expect(screen.queryByText('Back 3')).toBeNull();
    expect(screen.queryByText(/Back \d/)).toBeNull();
    expect(screen.queryByText('Front 1')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Confident/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show answer' })).toBeTruthy();
  });

  it('reveals the answer only on request, then offers the three confidence choices', async () => {
    const { user } = setup();
    await start(user);
    await show(user);
    expect(within(screen.getByRole('region', { name: 'Answer' })).getByText('Back 1')).toBeTruthy();
    const group = within(screen.getByRole('group', { name: 'How confident did you feel?' }));
    expect(group.getAllByRole('button').map((b) => b.textContent)).toEqual([
      expect.stringContaining('Not confident'),
      expect.stringContaining('Somewhat confident'),
      expect.stringContaining('Confident'),
    ]);
    expect(screen.queryByRole('button', { name: 'Show answer' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Skip/ })).toBeNull(); // rate it instead
  });

  it('saves the rating first, then moves to the next card (and the answer is hidden again)', async () => {
    const gate = deferred<CardProgress>();
    const { user, record } = setup({ record: () => gate.promise });
    await start(user);
    await show(user);
    await choose(user, 'Somewhat confident');
    expect(record).toHaveBeenCalledWith(ID, 'f1', { confidence: 2, attemptId: 'attempt-1' });
    expect(heading()).toBe('Front 1'); // still here until it is saved
    gate.resolve(progressOf('f1', 2));
    await waitFor(() => expect(heading()).toBe('Front 2'));
    expect(screen.queryByText('Back 2')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show answer' })).toBeTruthy();
  });

  it('cannot be rated twice while the first save is in flight', async () => {
    const gate = deferred<CardProgress>();
    const { user, record } = setup({ record: () => gate.promise });
    await start(user);
    await show(user);
    const confident = screen.getByRole('button', { name: /^Confident/ });
    await user.dblClick(confident);
    await user.click(screen.getByRole('button', { name: /^Not confident/ }));
    expect(record).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole('group', { name: 'How confident did you feel?' }) as HTMLFieldSetElement)
        .disabled,
    ).toBe(true);
    gate.resolve(progressOf('f1', 3));
    await waitFor(() => expect(heading()).toBe('Front 2'));
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('keeps the card, the answer and the choice when saving fails, and retries the same attempt', async () => {
    const record = vi
      .fn<PracticeApi['record']>()
      .mockRejectedValueOnce(
        new ApiError(
          0,
          'NETWORK_ERROR',
          'Could not reach the server. Check your connection and try again.',
        ),
      )
      .mockImplementation(async (_k, id, r) => progressOf(id, r.confidence));
    const { user } = setup({ record });
    await start(user);
    await show(user);
    await choose(user, 'Confident');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/That rating was not saved/);
    expect(alert.textContent).toMatch(/Could not reach the server/);
    expect(alert.textContent).toMatch(/nothing was lost/);
    expect(heading()).toBe('Front 1');
    expect(screen.getByRole('region', { name: 'Answer' })).toBeTruthy();

    await user.click(within(alert).getByRole('button', { name: 'Try saving again' }));
    await waitFor(() => expect(heading()).toBe('Front 2'));
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[1]![2]).toEqual(record.mock.calls[0]![2]); // the SAME attempt, so the server counts it once
  });

  it.each([
    [new ApiError(401, 'SESSION_EXPIRED', 'x'), /session ended/],
    [new ApiError(404, 'NOT_FOUND', 'x'), /no longer exists/],
    [new Error('ECONNREFUSED 10.0.0.5'), /could not be saved/],
  ])('explains a save failure safely (%#)', async (error, pattern) => {
    const { user } = setup({
      record: async () => {
        throw error;
      },
    });
    await start(user);
    await show(user);
    await choose(user, 'Confident');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(pattern);
    expect(document.body.textContent).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
  });

  it('skipping passes a card without recording anything, and it stays uncovered', async () => {
    const { user, record } = setup({ cards: 2 });
    await start(user);
    await user.click(screen.getByRole('button', { name: 'Skip this card for now' }));
    expect(record).not.toHaveBeenCalled();
    expect(heading()).toBe('Front 2');
  });
});

describe('finishing, repeating and resetting', () => {
  async function finishAll(user: ReturnType<typeof userEvent.setup>, levels: string[]) {
    await start(user);
    for (const level of levels) {
      await show(user);
      await choose(user, level);
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: 'Show answer' }) !== null ||
            screen.queryByText('Session complete') !== null,
        ).toBe(true),
      );
    }
  }

  it('shows a completion summary with this session and overall coverage', async () => {
    const { user } = setup();
    await finishAll(user, ['Not confident', 'Somewhat confident', 'Confident']);
    expect(await screen.findByText('Session complete')).toBeTruthy();
    expect(screen.getByText('You rated 3 of 3 cards this session.')).toBeTruthy();
    const counts = within(screen.getByRole('list', { name: 'This session by confidence' }));
    expect(counts.getByText('Not confident: 1')).toBeTruthy();
    expect(counts.getByText('Somewhat confident: 1')).toBeTruthy();
    expect(counts.getByText('Confident: 1')).toBeTruthy();
    expect(screen.getByText('Covered overall: 3 of 3 cards.')).toBeTruthy();
  });

  it('counts skipped cards honestly and leaves them uncovered', async () => {
    const { user } = setup({ cards: 2 });
    await start(user);
    await user.click(screen.getByRole('button', { name: 'Skip this card for now' }));
    await show(user);
    await choose(user, 'Confident');
    expect(
      await screen.findByText('You rated 1 of 2 cards this session and skipped 1.'),
    ).toBeTruthy();
    expect(screen.getByText('Covered overall: 1 of 2 cards; 1 not covered yet.')).toBeTruthy();
  });

  it('"Practise again" starts a new session ordered by what was least confident', async () => {
    const { user } = setup();
    await finishAll(user, ['Confident', 'Not confident', 'Somewhat confident']); // f1=3, f2=1, f3=2
    await user.click(await screen.findByRole('button', { name: 'Practise again' }));
    expect(heading()).toBe('Front 2'); // least confident first
    await show(user);
    await choose(user, 'Confident');
    await waitFor(() => expect(heading()).toBe('Front 3'));
    // the session counter starts again
    expect(screen.getByText(/Card 2 of 3 · 1 rated this session/)).toBeTruthy();
  });

  it('resets saved progress only after confirmation, and shows nothing covered afterwards', async () => {
    const { user, reset } = setup();
    await finishAll(user, ['Confident', 'Confident', 'Confident']);
    await user.click(await screen.findByRole('button', { name: 'Reset my progress' }));
    const group = within(
      screen.getByRole('group', { name: 'Confirm resetting practice progress' }),
    );
    await user.click(group.getByRole('button', { name: 'Cancel' }));
    expect(reset).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Reset my progress' }));
    await user.click(
      within(screen.getByRole('group', { name: 'Confirm resetting practice progress' })).getByRole(
        'button',
        { name: 'Yes, reset' },
      ),
    );
    await waitFor(() => expect(reset).toHaveBeenCalledWith(ID));
    expect(
      await screen.findByText('Covered overall: 0 of 3 cards; 3 not covered yet.'),
    ).toBeTruthy();
  });

  it('says so when the reset fails, and keeps the progress', async () => {
    const { user } = setup({
      reset: async () => {
        throw new ApiError(500, 'INTERNAL_ERROR', 'x');
      },
    });
    await finishAll(user, ['Confident', 'Confident', 'Confident']);
    await user.click(await screen.findByRole('button', { name: 'Reset my progress' }));
    await user.click(
      within(screen.getByRole('group', { name: 'Confirm resetting practice progress' })).getByRole(
        'button',
        { name: 'Yes, reset' },
      ),
    );
    expect(await screen.findByText(/Progress could not be reset/)).toBeTruthy();
    expect(screen.getByText('Covered overall: 3 of 3 cards.')).toBeTruthy();
  });

  it('offers a way back to the kit', async () => {
    const { user } = setup({ cards: 1 });
    await finishAll(user, ['Confident']);
    await screen.findByText('Session complete');
    const links = screen.getAllByRole('link', { name: 'Back to the kit' });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.getAttribute('href')).toBe(`/kits/${ID}`);
  });
});

describe('keyboard use, focus and announcements', () => {
  it('works with the keyboard alone, and moves focus with the session', async () => {
    const { user } = setup({ cards: 2 });
    await start(user);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 })),
    );
    screen.getByRole('button', { name: 'Show answer' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Answer' })),
    );
    await user.tab(); // the first confidence choice
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Not confident/ }));
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { level: 2, name: 'Front 2' }),
      ),
    );
    screen.getByRole('button', { name: 'Show answer' }).focus();
    await user.keyboard(' ');
    await user.tab();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'Session complete' }),
      ),
    );
  });

  it('announces the card, the answer being shown, the save and completion politely', async () => {
    const { user } = setup({ cards: 2 });
    await start(user);
    const live = () =>
      screen
        .getAllByRole('status')
        .map((n) => n.textContent)
        .join(' | ');
    await waitFor(() => expect(live()).toMatch(/Card 1 of 2/));
    await show(user);
    expect(live()).toMatch(/Answer shown/);
    await choose(user, 'Confident');
    await waitFor(() => expect(live()).toMatch(/Card 2 of 2|Saved: Confident/));
    for (const region of screen.getAllByRole('status'))
      expect(region.getAttribute('aria-live')).toBe('polite');
  });

  it('uses native buttons and a labelled group, with no hidden answer text', async () => {
    const { user } = setup({ cards: 1 });
    await start(user);
    for (const button of screen.getAllByRole('button')) expect(button.tagName).toBe('BUTTON');
    expect(document.body.textContent).not.toContain('Back 1');
    await show(user);
    expect(screen.getByRole('group', { name: 'How confident did you feel?' })).toBeTruthy();
  });
});
