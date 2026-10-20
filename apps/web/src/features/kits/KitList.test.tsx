// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import type { KitSummary } from '../../lib/api/kits';
import { deferred } from '../../test/auth';
import { KitList } from './KitList';

afterEach(cleanup);

const kit = (over: Partial<KitSummary> = {}): KitSummary => ({
  id: 'a'.repeat(24),
  company: 'Acme Corp',
  role: 'Senior Backend Engineer',
  version: 1,
  created_at: '2026-03-01T10:00:00.000Z',
  updated_at: '2026-03-01T10:00:00.000Z',
  ...over,
});

describe('KitList states', () => {
  it('shows a loading status first, with the create link already usable', () => {
    render(<KitList api={{ list: () => new Promise(() => undefined) }} />);
    expect(screen.getByRole('status').textContent).toMatch(/Loading your kits/);
    expect(screen.getByRole('link', { name: 'Create a kit' }).getAttribute('href')).toBe(
      '/kits/new',
    );
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('shows an empty state with a way to create the first kit', async () => {
    render(<KitList api={{ list: async () => [] }} />);
    expect(await screen.findByText('No kits yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create your first kit' }).getAttribute('href')).toBe(
      '/kits/new',
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('lists each kit with company, role, dates and a link to open it, in the order the server gave', async () => {
    const kits = [
      kit({ id: '1'.repeat(24), company: 'Zeta', role: 'SRE' }),
      kit({
        id: '2'.repeat(24),
        company: 'Acme',
        role: 'Backend',
        updated_at: '2026-03-05T10:00:00.000Z',
      }),
    ];
    render(<KitList api={{ list: async () => kits }} />);
    const list = await screen.findByRole('list', { name: 'Your kits' });
    const items = list.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toMatch(/Zeta.*SRE/);
    expect(items[1]?.textContent).toMatch(/Acme.*Backend/);
    const link = items[1]!.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(`/kits/${'2'.repeat(24)}`);
    // an edited kit shows both dates; an untouched one only the creation date
    expect(items[0]?.querySelectorAll('time')).toHaveLength(1);
    const times = items[1]!.querySelectorAll('time');
    expect(times).toHaveLength(2);
    expect(times[1]?.getAttribute('datetime')).toBe('2026-03-05T10:00:00.000Z');
  });

  it('shows hostile text from the server as plain text', async () => {
    render(
      <KitList api={{ list: async () => [kit({ company: '<img src=x onerror=alert(1)>' })] }} />,
    );
    await screen.findByRole('list', { name: 'Your kits' });
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  });
});

describe('KitList errors', () => {
  it('says what failed and retries on request, going back through loading to the list', async () => {
    const user = userEvent.setup();
    const pending = deferred<KitSummary[]>();
    const list = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(
          0,
          'NETWORK_ERROR',
          'Could not reach the server. Check your connection and try again.',
        ),
      )
      .mockReturnValueOnce(pending.promise);
    render(<KitList api={{ list }} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Could not load your kits/);
    expect(alert.textContent).toMatch(/Could not reach the server/);
    expect(screen.queryByText('No kits yet')).toBeNull(); // a failure is not an empty list

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('status').textContent).toMatch(/Loading your kits/);
    pending.resolve([kit()]);
    expect(await screen.findByRole('list', { name: 'Your kits' })).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('shows a server error with its message and a retry', async () => {
    render(
      <KitList
        api={{
          list: async () => {
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

  it('on an ended session offers no retry (the app is already sending the user to sign in)', async () => {
    render(
      <KitList
        api={{
          list: async () => {
            throw new ApiError(401, 'SESSION_EXPIRED', 'x');
          },
        }}
      />,
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(/session ended/);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('never shows the text of an unexpected error', async () => {
    render(
      <KitList
        api={{
          list: async () => {
            throw new Error('connect ECONNREFUSED 10.0.0.5:27017');
          },
        }}
      />,
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Something went wrong/);
    expect(document.body.textContent).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
  });

  it('ignores the request it cancelled when it goes away', async () => {
    const list = vi.fn(
      (opts?: { signal?: AbortSignal }) =>
        new Promise<KitSummary[]>((_, reject) =>
          opts?.signal?.addEventListener('abort', () =>
            reject(new ApiError(0, 'ABORTED', 'cancelled')),
          ),
        ),
    );
    const { unmount } = render(<KitList api={{ list }} />);
    unmount();
    await Promise.resolve();
    expect(list.mock.calls[0]?.[0]?.signal?.aborted).toBe(true);
  });
});
