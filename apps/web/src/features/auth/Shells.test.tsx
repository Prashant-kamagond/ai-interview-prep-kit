// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import {
  deferred,
  fakeAuthApi,
  networkDown,
  renderWithAuth,
  sessionBus,
  unauthenticated,
  USER,
} from '../../test/auth';
import { nav, resetNavigation, router } from '../../test/navigation';
import { GuestOnly } from './GuestOnly';
import { ProtectedShell } from './ProtectedShell';

vi.mock('next/navigation', async () => (await import('../../test/navigation')).navigationMock);

afterEach(cleanup);

const signedIn = () => fakeAuthApi({ me: vi.fn(async () => USER) });
const signedOut = () =>
  fakeAuthApi({
    me: vi.fn(async () => {
      throw unauthenticated();
    }),
  });

describe('ProtectedShell', () => {
  beforeEach(() => resetNavigation('/kits'));

  it('shows only a status while the session is checked, never the page or a redirect', () => {
    renderWithAuth(<ProtectedShell>secret page</ProtectedShell>);
    expect(screen.getByRole('status').textContent).toMatch(/Checking your session/);
    expect(screen.queryByText('secret page')).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('shows the page, the nav and the user once signed in', async () => {
    renderWithAuth(<ProtectedShell>secret page</ProtectedShell>, signedIn());
    expect(await screen.findByText('secret page')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(screen.getByText('ada@example.com')).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('sends a signed-out visitor to sign in, remembering where they were going', async () => {
    resetNavigation('/kits/abc', '?tab=2');
    renderWithAuth(<ProtectedShell>secret page</ProtectedShell>, signedOut());
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith('/login?next=%2Fkits%2Fabc%3Ftab%3D2'),
    );
    expect(screen.queryByText('secret page')).toBeNull();
  });

  it('does not add a next parameter for the default landing page', async () => {
    renderWithAuth(<ProtectedShell>secret page</ProtectedShell>, signedOut());
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login'));
  });

  it('explains an expired session on the sign-in page and removes the page content at once', async () => {
    const bus = sessionBus();
    resetNavigation('/kits/abc');
    renderWithAuth(<ProtectedShell>secret page</ProtectedShell>, signedIn(), bus);
    await screen.findByText('secret page');
    act(() => bus.lose());
    expect(screen.queryByText('secret page')).toBeNull();
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith('/login?expired=1&next=%2Fkits%2Fabc'),
    );
  });

  it('a deliberate sign-out goes to plain /login without a next parameter', async () => {
    const user = userEvent.setup();
    resetNavigation('/kits/abc');
    const api = signedIn();
    renderWithAuth(<ProtectedShell>secret page</ProtectedShell>, api);
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login'));
    expect(api.logout).toHaveBeenCalledTimes(1);
  });

  it('says plainly when the server cannot be reached, and retries on request', async () => {
    const user = userEvent.setup();
    const me = vi.fn().mockRejectedValueOnce(networkDown()).mockResolvedValueOnce(USER);
    renderWithAuth(<ProtectedShell>secret page</ProtectedShell>, fakeAuthApi({ me }));
    expect(await screen.findByText('Could not check your session')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/Could not reach the server/);
    expect(router.replace).not.toHaveBeenCalled(); // an outage is not a sign-out
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('secret page')).toBeTruthy();
    expect(me).toHaveBeenCalledTimes(2);
  });
});

describe('GuestOnly', () => {
  beforeEach(() => resetNavigation('/login'));

  it('shows the form to a signed-out visitor', async () => {
    renderWithAuth(<GuestOnly>the form</GuestOnly>, signedOut());
    expect(await screen.findByText('the form')).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('never flashes the form while the session is being checked', () => {
    renderWithAuth(<GuestOnly>the form</GuestOnly>);
    expect(screen.queryByText('the form')).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/Checking your session/);
  });

  it('sends a signed-in user to their kits', async () => {
    renderWithAuth(<GuestOnly>the form</GuestOnly>, signedIn());
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/kits'));
    expect(screen.queryByText('the form')).toBeNull();
  });

  it('honours a safe next path and ignores an unsafe one', async () => {
    resetNavigation('/login', '?next=%2Fkits%2Fabc');
    const { unmount } = renderWithAuth(<GuestOnly>the form</GuestOnly>, signedIn());
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/kits/abc'));
    unmount();

    resetNavigation('/login', '?next=https%3A%2F%2Fevil.example');
    renderWithAuth(<GuestOnly>the form</GuestOnly>, signedIn());
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/kits'));
    expect(router.replace).not.toHaveBeenCalledWith(expect.stringContaining('evil'));
  });

  it('offers a retry when the server cannot be reached', async () => {
    const me = vi.fn().mockRejectedValue(new ApiError(500, 'HTTP_500', 'Server problem'));
    renderWithAuth(<GuestOnly>the form</GuestOnly>, fakeAuthApi({ me }));
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText('the form')).toBeNull();
  });
});

describe('AppNav sign-out', () => {
  beforeEach(() => resetNavigation('/kits'));

  it('disables the button while signing out', async () => {
    const pending = deferred<undefined>();
    const user = userEvent.setup();
    const api = fakeAuthApi({ me: vi.fn(async () => USER), logout: vi.fn(() => pending.promise) });
    renderWithAuth(<ProtectedShell>page</ProtectedShell>, api);
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    const busy = await screen.findByRole('button', { name: 'Signing out…' });
    expect(busy.hasAttribute('disabled')).toBe(true);
    pending.resolve(undefined);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/login'));
  });

  it('stays signed in and says so if the server could not be told', async () => {
    const user = userEvent.setup();
    const api = fakeAuthApi({
      me: vi.fn(async () => USER),
      logout: vi.fn(async () => {
        throw networkDown();
      }),
    });
    renderWithAuth(<ProtectedShell>page</ProtectedShell>, api);
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not reach the server/);
    expect(screen.getByText('page')).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sign out' }).hasAttribute('disabled')).toBe(false);
  });
});

describe('AuthProvider', () => {
  beforeEach(() => resetNavigation('/kits'));

  it('does not report an aborted restore as a failure when it unmounts', async () => {
    const me = vi.fn(
      (opts?: { signal?: AbortSignal }) =>
        new Promise<never>((_, reject) =>
          opts?.signal?.addEventListener('abort', () =>
            reject(new ApiError(0, 'ABORTED', 'aborted')),
          ),
        ),
    );
    const { unmount } = renderWithAuth(<ProtectedShell>page</ProtectedShell>, fakeAuthApi({ me }));
    unmount();
    await Promise.resolve();
    expect(nav.pathname).toBe('/kits');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('throws a clear error when a hook is used outside the provider', async () => {
    const { render } = await import('@testing-library/react');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<GuestOnly>x</GuestOnly>)).toThrow(/inside <AuthProvider>/);
    spy.mockRestore();
  });
});
