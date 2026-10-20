// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import type { KitRecord } from '../../lib/api/kits';
import { deferred } from '../../test/auth';
import { makeEmptyKit, makeKit, makeRecord } from '../../test/kit';
import { KitViewer } from './KitViewer';

afterEach(cleanup);

const ID = 'a'.repeat(24);
const show = (record: KitRecord = makeRecord()) =>
  render(<KitViewer id={ID} api={{ get: async () => record }} />);
const section = async (name: string | RegExp) =>
  within(await screen.findByRole('region', { name }));

describe('a complete kit', () => {
  it('shows the title, the details and every section as a labelled landmark', async () => {
    show(makeRecord(makeKit(), { updated_at: '2026-03-05T10:00:00.000Z' }));
    expect(await screen.findByRole('heading', { level: 1, name: /Acme Corp/ })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(
      /Senior Backend Engineer/,
    );
    expect(screen.getByText(/Senior · Remote \(EU\) · Created .* · Updated /)).toBeTruthy();
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
  });

  it('offers a way back to the list and anchors to each section, all as real links', async () => {
    show();
    const back = await screen.findByRole('link', { name: /Back to your kits/ });
    expect(back.getAttribute('href')).toBe('/kits');
    const nav = screen.getByRole('navigation', { name: 'On this page' });
    const hrefs = within(nav)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      '#company',
      '#role',
      '#questions',
      '#flashcards',
      '#schedule',
      '#coverage',
    ]);
    for (const h of hrefs) expect(document.querySelector(h!)).not.toBeNull();
  });

  it('shows the company brief text', async () => {
    show();
    const brief = await section('Company brief');
    expect(brief.getByText('Acme builds payment tools for small shops.')).toBeTruthy();
    expect(brief.getByText('Card readers and a dashboard.')).toBeTruthy();
  });

  it('separates must-have from nice-to-have requirements, with responsibilities', async () => {
    show();
    const role = await section('Role and requirements');
    expect(role.getByText('Design services')).toBeTruthy();
    const must = role.getByRole('heading', { name: 'Must-have (3)' }).parentElement!;
    const nice = role.getByRole('heading', { name: 'Nice-to-have (1)' }).parentElement!;
    expect(within(must).getByText(/Build REST APIs in Node.js/)).toBeTruthy();
    expect(within(must).getByText(/Operate Kubernetes in production/)).toBeTruthy();
    expect(within(must).queryByText(/Experience with payments/)).toBeNull();
    expect(within(nice).getByText(/Experience with payments/)).toBeTruthy();
  });
});

describe('questions and flashcards', () => {
  it('groups questions by category, with difficulty and the requirements each one tests', async () => {
    show();
    const questions = await section(/^Questions/);
    const groups = questions.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(groups).toEqual([
      'Technical (1)',
      'Behavioural (1)',
      'System design (1)',
      'Company fit (1)',
    ]);
    const design = within(
      questions.getByRole('heading', { name: 'System design (1)' }).parentElement!,
    );
    expect(design.getByText('Design a payment webhook system.')).toBeTruthy();
    expect(design.getByText(/Difficulty 3 of 3/)).toBeTruthy();
    expect(design.getByText(/Build REST APIs in Node.js/)).toBeTruthy();
    expect(design.getByText(/Experience with payments/)).toBeTruthy();
    // a question with no references says so
    const fit = within(questions.getByRole('heading', { name: 'Company fit (1)' }).parentElement!);
    expect(fit.getByText('Tests: none listed.')).toBeTruthy();
  });

  it('puts answer outlines behind a keyboard-operable disclosure, with a fallback when empty', async () => {
    const user = userEvent.setup();
    show();
    const questions = await section(/^Questions/);
    const technical = within(
      questions.getByRole('heading', { name: 'Technical (1)' }).parentElement!,
    );
    const summary = technical.getByText('Answer outline');
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    expect(summary.tagName).toBe('SUMMARY'); // the native control: focusable, Enter and Space toggle it
    await user.click(summary);
    expect(details.open).toBe(true);
    expect(technical.getByText(/URL vs header versioning/)).toBeTruthy();
    expect(questions.getByText('No answer outline was provided.')).toBeTruthy();
  });

  it('marks a reference that matches no requirement instead of hiding it', async () => {
    const kit = makeKit();
    show(makeRecord({ ...kit, questions: [{ ...kit.questions[0]!, requirement_ids: ['ghost'] }] }));
    expect(await screen.findByText(/\(not found in this kit\)/)).toBeTruthy();
  });

  it('shows flashcards with a collapsed answer and their references', async () => {
    show();
    const cards = await section(/^Flashcards/);
    expect(cards.getByText('What is idempotency?')).toBeTruthy();
    expect(cards.getByText('Show answer').closest('details')!.open).toBe(false);
    expect(cards.getByText('Same request, same effect.')).toBeTruthy();
    expect(cards.getByText(/Build REST APIs in Node.js/)).toBeTruthy();
  });
});

describe('schedule', () => {
  it('lists the days in order with focus, minutes and the scheduled questions', async () => {
    show();
    const schedule = await section('Preparation schedule');
    expect(
      schedule.getByText('3 days available · 3 days planned · 180 minutes in total'),
    ).toBeTruthy();
    const days = schedule.getAllByRole('listitem').filter((li) => li.querySelector('h3'));
    expect(days.map((d) => d.querySelector('h3')!.textContent)).toEqual([
      'Day 1 · 60 minutes',
      'Day 2 · 90 minutes',
      'Day 3 · 30 minutes',
    ]);
    expect(days[0]?.textContent).toMatch(/Focus: APIs/);
    expect(days[0]?.textContent).toMatch(/How do you version a REST API\?/);
    expect(days[0]?.textContent).toMatch(/Why Acme\?/);
    // day 2 keeps the kit's own question order
    const text = days[1]!.textContent!;
    expect(text.indexOf('Design a payment webhook system.')).toBeLessThan(
      text.indexOf('Tell me about a disagreement'),
    );
    expect(days[2]?.textContent).toMatch(/No questions are scheduled this day/);
  });

  it('says so when the schedule names a question the kit does not have', async () => {
    const kit = makeKit();
    show(
      makeRecord({
        ...kit,
        schedule: {
          days_available: 1,
          days: [{ day: 1, focus: 'F', question_ids: ['ghost'], minutes: 10 }],
        },
      }),
    );
    expect(await screen.findByText(/is scheduled but is not in this kit/)).toBeTruthy();
  });

  it('shows a mismatch between days available and days planned instead of hiding it', async () => {
    const kit = makeKit();
    show(makeRecord({ ...kit, schedule: { ...kit.schedule, days_available: 10 } }));
    expect(await screen.findByText(/10 days available · 3 days planned/)).toBeTruthy();
  });
});

describe('coverage', () => {
  it('says what is covered and lists each uncovered requirement with its priority', async () => {
    show();
    const coverage = await section('Coverage');
    expect(coverage.getByRole('status').textContent).toBe(
      '3 of 4 requirements are covered; 1 not covered.',
    );
    const gap = coverage.getByRole('heading', { name: /Not covered \(1\)/ }).parentElement!;
    expect(gap.textContent).toMatch(/1 must-have/);
    expect(within(gap).getByText(/Operate Kubernetes in production/)).toBeTruthy();
    expect(within(gap).getByText('(Must-have)')).toBeTruthy();
    expect(coverage.queryByText(/reports no uncovered/)).toBeNull();
  });

  it('does not suggest full coverage when the kit lists a gap, and only says so when it lists none', async () => {
    const kit = makeKit();
    const { unmount } = show();
    await screen.findByRole('region', { name: 'Coverage' });
    expect(screen.queryByText(/every requirement/i)).toBeNull();
    unmount();
    show(makeRecord({ ...kit, coverage: { uncovered_requirement_ids: [], passes: 1 } }));
    const coverage = await section('Coverage');
    expect(coverage.getByRole('status').textContent).toBe('4 of 4 requirements are covered.');
    expect(coverage.getByText('The kit reports no uncovered requirements.')).toBeTruthy();
  });

  it('shows an uncovered id that matches no requirement, flagged', async () => {
    const kit = makeKit();
    show(makeRecord({ ...kit, coverage: { uncovered_requirement_ids: ['zzz'], passes: 1 } }));
    const coverage = await section('Coverage');
    expect(coverage.getByText('(not found in this kit)')).toBeTruthy();
  });
});

describe('sources', () => {
  it('links recorded web addresses safely, with no claim that they were checked', async () => {
    show();
    const brief = await section('Company brief');
    const careers = brief.getByRole('link', { name: /acme\.example\/careers/ });
    expect(careers.getAttribute('href')).toBe('https://acme.example/careers');
    expect(careers.getAttribute('target')).toBe('_blank');
    expect(careers.getAttribute('rel')).toBe('noopener noreferrer');
    expect(careers.textContent).toMatch(/opens in a new tab/);
    expect(brief.getByRole('link', { name: /^https:\/\/acme\.example\s*\(opens/ })).toBeTruthy();
    // shown once even though it appears twice in the kit
    expect(brief.getAllByRole('link', { name: /acme\.example\/careers/ })).toHaveLength(1);
    // text that is not a web address is shown as text, never as a link
    expect(brief.getByText('not a url').closest('a')).toBeNull();
    expect(brief.getByText('javascript:alert(1)').closest('a')).toBeNull();
    expect(brief.getByText(/have not been checked again/)).toBeTruthy();
    expect(brief.queryByText(/verified/i)).toBeNull();
  });
});

describe('a kit with nothing in it', () => {
  it('renders every section with an honest fallback and does not crash', async () => {
    show(makeRecord(makeEmptyKit()));
    expect(await screen.findByRole('heading', { level: 1, name: /Unnamed company/ })).toBeTruthy();
    expect(screen.getAllByText('Not provided.')).toHaveLength(2);
    expect(screen.getByText('No sources were recorded for this kit.')).toBeTruthy();
    expect(screen.getByText('No responsibilities were extracted.')).toBeTruthy();
    expect(screen.getByText('No requirements were extracted for this role.')).toBeTruthy();
    expect(screen.getByText('This kit has no questions.')).toBeTruthy();
    expect(screen.getByText('This kit has no flashcards.')).toBeTruthy();
    expect(screen.getByText('This kit has no scheduled days.')).toBeTruthy();
    expect(screen.getByText(/lists no requirements, so there is nothing to cover/)).toBeTruthy();
    expect(screen.queryByText(/of 0 requirements/)).toBeNull();
  });
});

describe('markup that must survive long or hostile content', () => {
  it('shows text from the kit as text and lets long words wrap', async () => {
    const kit = makeKit();
    const long = 'https://acme.example/' + 'a'.repeat(300);
    show(
      makeRecord({
        ...kit,
        company_brief: {
          ...kit.company_brief,
          summary: '<img src=x onerror=alert(1)>',
          sources: [long],
        },
        questions: [{ ...kit.questions[0]!, prompt: 'W'.repeat(400) }],
      }),
    );
    await screen.findByRole('region', { name: 'Company brief' });
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    const link = screen.getByRole('link', { name: new RegExp('a{300}') });
    expect(link.className).toMatch(/overflow-wrap:anywhere/);
    for (const el of screen.getAllByText('W'.repeat(400))) {
      expect(el.className).toMatch(/overflow-wrap:anywhere/);
    }
  });
});

describe('loading and failing', () => {
  it('announces loading, then shows the kit', async () => {
    const pending = deferred<KitRecord>();
    render(<KitViewer id={ID} api={{ get: () => pending.promise }} />);
    expect(screen.getByRole('status').textContent).toMatch(/Loading your kit/);
    pending.resolve(makeRecord());
    expect(await screen.findByRole('heading', { level: 1, name: /Acme Corp/ })).toBeTruthy();
    expect(screen.queryByText(/Loading your kit/)).toBeNull();
  });

  it('asks the API for exactly the kit named in the address', async () => {
    const get = vi.fn(async () => makeRecord());
    render(<KitViewer id={ID} api={{ get }} />);
    await screen.findByRole('heading', { level: 1 });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(
      ID,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("says not found, with the way back, when the API says 404 (also for another user's kit)", async () => {
    render(
      <KitViewer
        id={ID}
        api={{
          get: async () => {
            throw new ApiError(404, 'NOT_FOUND', 'Kit not found');
          },
        }}
      />,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Kit not found' })).toBeTruthy();
    expect(screen.getByText(/does not exist, or it is not in your account/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to your kits' }).getAttribute('href')).toBe(
      '/kits',
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('does not even ask the API about an address that cannot be a kit', () => {
    const get = vi.fn();
    render(<KitViewer id="../../auth/me" api={{ get }} />);
    expect(screen.getByRole('heading', { name: 'Kit not found' })).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
  });

  it('on an ended session says so with no retry, and a way back', async () => {
    render(
      <KitViewer
        id={ID}
        api={{
          get: async () => {
            throw new ApiError(401, 'SESSION_EXPIRED', 'x');
          },
        }}
      />,
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Your session ended/);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to your kits' })).toBeTruthy();
  });

  it('shows a network failure with a retry that goes through loading to the kit', async () => {
    const user = userEvent.setup();
    const pending = deferred<KitRecord>();
    const get = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(
          0,
          'NETWORK_ERROR',
          'Could not reach the server. Check your connection and try again.',
        ),
      )
      .mockReturnValueOnce(pending.promise);
    render(<KitViewer id={ID} api={{ get }} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Could not load this kit/);
    expect(alert.textContent).toMatch(/Could not reach the server/);
    expect(screen.getByRole('link', { name: 'Back to your kits' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('status').textContent).toMatch(/Loading your kit/);
    pending.resolve(makeRecord());
    expect(await screen.findByRole('heading', { level: 1, name: /Acme Corp/ })).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('shows a server error with a retry', async () => {
    render(
      <KitViewer
        id={ID}
        api={{
          get: async () => {
            throw new ApiError(
              500,
              'HTTP_500',
              'The server had a problem. Please try again in a moment.',
            );
          },
        }}
      />,
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(/server had a problem/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('refuses to show a kit that fails validation, says why in plain words, and allows a retry', async () => {
    render(
      <KitViewer
        id={ID}
        api={{
          get: async () => {
            throw new ApiError(200, 'BAD_RESPONSE', 'internal detail');
          },
        }}
      />,
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not read, so it is not shown/);
    expect(alert.textContent).not.toMatch(/internal detail/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Coverage' })).toBeNull();
  });

  it('never shows the text of an unexpected error', async () => {
    render(
      <KitViewer
        id={ID}
        api={{
          get: async () => {
            throw new Error('ECONNREFUSED 10.0.0.5');
          },
        }}
      />,
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Something went wrong/);
    expect(document.body.textContent).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
  });

  it('cancels its request when it goes away', () => {
    const get = vi.fn(() => new Promise<KitRecord>(() => undefined));
    const { unmount } = render(<KitViewer id={ID} api={{ get }} />);
    unmount();
    expect((get.mock.calls[0] as unknown[])[1]).toMatchObject({ signal: { aborted: true } });
  });
});
