// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { deferred, fakeAuthApi, renderWithAuth, USER } from '../../test/auth';
import { resetNavigation } from '../../test/navigation';
import { CredentialsForm } from './CredentialsForm';

vi.mock('next/navigation', async () => (await import('../../test/navigation')).navigationMock);

beforeEach(() => resetNavigation('/login'));
afterEach(cleanup);

const GOOD = { email: 'Ada@Example.com ', password: 'a long enough password' };

async function fill(user: ReturnType<typeof userEvent.setup>, email: string, password: string) {
  if (email) await user.type(screen.getByLabelText('Email'), email);
  if (password) await user.type(screen.getByLabelText('Password'), password);
}

describe('structure and accessibility', () => {
  it('has labelled fields with the right autocomplete hints, per mode', () => {
    const { unmount } = renderWithAuth(<CredentialsForm mode="login" />);
    expect(screen.getByLabelText('Email')).toHaveProperty('autocomplete', 'email');
    expect(screen.getByLabelText('Password')).toHaveProperty('autocomplete', 'current-password');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeTruthy();
    unmount();
    renderWithAuth(<CredentialsForm mode="register" />);
    expect(screen.getByLabelText('Password')).toHaveProperty('autocomplete', 'new-password');
    expect(screen.getByText(/At least 10 characters/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
  });

  it('links to the other page', () => {
    renderWithAuth(<CredentialsForm mode="login" />);
    expect(screen.getByRole('link', { name: 'Create an account' }).getAttribute('href')).toBe(
      '/register',
    );
  });

  it('shows a notice politely (role status), for example after a session expired', () => {
    renderWithAuth(
      <CredentialsForm mode="login" notice="Your session expired. Sign in again to continue." />,
    );
    expect(screen.getByRole('status').textContent).toMatch(/session expired/);
  });
});

describe('checking the input before sending anything', () => {
  it('explains each problem in plain words, marks the fields invalid, and moves focus to the first one', async () => {
    const api = fakeAuthApi();
    const user = userEvent.setup();
    renderWithAuth(<CredentialsForm mode="login" />, api);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const email = screen.getByLabelText('Email');
    const password = screen.getByLabelText('Password');
    expect(screen.getByText('Enter a valid email address.')).toBeTruthy();
    expect(screen.getByText('Enter your password.')).toBeTruthy();
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(email.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Enter a valid email address.',
    );
    expect(password.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(email);
    expect(api.login).not.toHaveBeenCalled();
  });

  it('moves focus to the password when only the password is wrong (registration length rule)', async () => {
    const api = fakeAuthApi();
    const user = userEvent.setup();
    renderWithAuth(<CredentialsForm mode="register" />, api);
    await fill(user, 'ada@example.com', 'short');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByText('Use 10 to 128 characters for your password.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Password'));
    expect(api.register).not.toHaveBeenCalled();
  });
});

describe('submitting', () => {
  it('sends the cleaned-up email and the password, once, and disables the button while waiting', async () => {
    const pending = deferred<typeof USER>();
    const api = fakeAuthApi({ login: vi.fn(() => pending.promise) });
    const user = userEvent.setup();
    renderWithAuth(<CredentialsForm mode="login" />, api);
    await fill(user, GOOD.email, GOOD.password);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const busy = await screen.findByRole('button', { name: 'Signing in…' });
    expect(busy.hasAttribute('disabled')).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    // A second click while the first request is in flight does nothing.
    await user.click(busy);
    expect(api.login).toHaveBeenCalledTimes(1);
    expect(api.login).toHaveBeenCalledWith({ email: 'ada@example.com', password: GOOD.password });
    pending.resolve(USER);
  });

  it('can be submitted from the keyboard alone', async () => {
    const api = fakeAuthApi();
    const user = userEvent.setup();
    renderWithAuth(<CredentialsForm mode="login" />, api);
    await user.tab(); // email
    expect(document.activeElement).toBe(screen.getByLabelText('Email'));
    await user.keyboard('ada@example.com');
    await user.tab(); // password
    await user.keyboard('a long enough password{Enter}');
    await waitFor(() => expect(api.login).toHaveBeenCalledTimes(1));
  });

  it('registers through the register call', async () => {
    const api = fakeAuthApi();
    const user = userEvent.setup();
    renderWithAuth(<CredentialsForm mode="register" />, api);
    await fill(user, 'ada@example.com', GOOD.password);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() =>
      expect(api.register).toHaveBeenCalledWith({
        email: 'ada@example.com',
        password: GOOD.password,
      }),
    );
    expect(api.login).not.toHaveBeenCalled();
  });
});

describe('when the server says no', () => {
  async function failWith(error: unknown, mode: 'login' | 'register' = 'login') {
    const api = fakeAuthApi({
      login: vi.fn(async () => {
        throw error;
      }),
      register: vi.fn(async () => {
        throw error;
      }),
    });
    const user = userEvent.setup();
    renderWithAuth(<CredentialsForm mode={mode} />, api);
    await fill(user, 'ada@example.com', GOOD.password);
    await user.click(
      screen.getByRole('button', { name: mode === 'login' ? 'Sign in' : 'Create account' }),
    );
    return api;
  }

  it('says the email or password is incorrect, announces it, focuses it and lets the user retry', async () => {
    await failWith(new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Email or password is incorrect.');
    expect(document.activeElement).toBe(alert);
    expect(screen.getByRole('button', { name: 'Sign in' }).hasAttribute('disabled')).toBe(false);
    // What the user typed is still there, so they can correct it.
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('ada@example.com');
  });

  it('puts an already-registered email on the email field', async () => {
    await failWith(new ApiError(409, 'EMAIL_TAKEN', 'taken'), 'register');
    expect(await screen.findByText(/already exists/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Email'));
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true');
  });

  it('maps server validation details onto the right fields', async () => {
    await failWith(
      new ApiError(400, 'VALIDATION_ERROR', 'Invalid', [
        { path: 'password', message: 'Too small' },
      ]),
      'register',
    );
    expect(await screen.findByText('Use 10 to 128 characters for your password.')).toBeTruthy();
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBeNull();
  });

  it('asks the user to wait after too many attempts', async () => {
    await failWith(new ApiError(429, 'RATE_LIMITED', 'Too many requests'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Too many attempts/);
  });

  it('shows the fixed network message, not the underlying error', async () => {
    await failWith(
      new ApiError(
        0,
        'NETWORK_ERROR',
        'Could not reach the server. Check your connection and try again.',
      ),
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not reach the server/);
  });

  it('shows a generic message for anything unexpected, never its text', async () => {
    await failWith(new Error('connect ECONNREFUSED mongodb://admin:hunter2@internal-host'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Something went wrong. Please try again.');
    expect(document.body.textContent).not.toMatch(/hunter2|ECONNREFUSED|internal-host/);
  });

  it('never writes the password into the page text', async () => {
    await failWith(new ApiError(401, 'INVALID_CREDENTIALS', 'x'));
    await screen.findByRole('alert');
    expect(document.body.textContent).not.toContain(GOOD.password);
  });
});
