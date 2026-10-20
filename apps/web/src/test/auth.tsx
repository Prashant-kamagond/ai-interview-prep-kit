import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import type { AuthApi, User } from '../lib/api/auth';
import { ApiError } from '../lib/api/client';
import { AuthProvider } from '../lib/auth/AuthProvider';

export const USER: User = { id: 'u1', email: 'ada@example.com' };

export const unauthenticated = () =>
  new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
export const networkDown = () =>
  new ApiError(
    0,
    'NETWORK_ERROR',
    'Could not reach the server. Check your connection and try again.',
  );

/** An auth API whose calls the test controls. `me` never answers unless told to. */
export function fakeAuthApi(over: Partial<AuthApi> = {}): AuthApi & {
  me: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
} {
  return {
    me: vi.fn(() => new Promise<User>(() => undefined)),
    login: vi.fn(async () => USER),
    register: vi.fn(async () => USER),
    logout: vi.fn(async () => undefined),
    ...over,
  } as never;
}

/** The listener the provider registers for "the session was lost", so a test can fire it. */
export function sessionBus() {
  let listener: ((error: ApiError) => void) | undefined;
  return {
    subscribe: (l: (error: ApiError) => void) => {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
    lose: () => listener?.(unauthenticated()),
  };
}

export function renderWithAuth(
  ui: ReactElement,
  api: AuthApi = fakeAuthApi(),
  bus: ReturnType<typeof sessionBus> = sessionBus(),
) {
  return render(
    <AuthProvider api={api} subscribe={bus.subscribe}>
      {ui}
    </AuthProvider>,
  );
}

/** A promise a test settles by hand, to observe a request while it is in flight. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
