import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { authReducer, initialAuthState, type AuthAction, type AuthState } from './state';

const user = { id: 'u1', email: 'a@example.com' };
const run = (actions: AuthAction[], from: AuthState = initialAuthState) =>
  actions.reduce(authReducer, from);

describe('restoring the session on load', () => {
  it('starts in loading, so a protected page never flashes content or a redirect', () => {
    expect(initialAuthState).toEqual({ status: 'loading' });
  });

  it('becomes authenticated when the server knows the user', () => {
    expect(run([{ type: 'restored', user }])).toEqual({ status: 'authenticated', user });
  });

  it('becomes signed out (no reason to explain) on a 401', () => {
    const state = run([
      { type: 'restore-failed', error: new ApiError(401, 'UNAUTHENTICATED', 'x') },
    ]);
    expect(state).toEqual({ status: 'unauthenticated', reason: 'none' });
  });

  it('becomes an error, with the safe message, on a network or server failure', () => {
    const state = run([
      {
        type: 'restore-failed',
        error: new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server.'),
      },
    ]);
    expect(state).toEqual({ status: 'error', message: 'Could not reach the server.' });
    expect(
      run([{ type: 'restore-failed', error: new ApiError(500, 'HTTP_500', 'Server problem') }])
        .status,
    ).toBe('error');
  });

  it('goes back to loading on retry, and only from an error', () => {
    const failed: AuthState = { status: 'error', message: 'x' };
    expect(run([{ type: 'retry' }], failed)).toEqual({ status: 'loading' });
    expect(run([{ type: 'retry' }], { status: 'authenticated', user }).status).toBe(
      'authenticated',
    );
  });

  it('ignores a late restore result after the user already signed in or out', () => {
    const lateRestore: AuthAction = {
      type: 'restored',
      user: { id: 'other', email: 'x@example.com' },
    };
    expect(run([{ type: 'signed-in', user }, lateRestore])).toEqual({
      status: 'authenticated',
      user,
    });
    expect(run([{ type: 'signed-out' }, lateRestore]).status).toBe('unauthenticated');
    const lateFailure: AuthAction = {
      type: 'restore-failed',
      error: new ApiError(0, 'NETWORK_ERROR', 'x'),
    };
    expect(run([{ type: 'signed-in', user }, lateFailure])).toEqual({
      status: 'authenticated',
      user,
    });
  });
});

describe('signing in, out and losing the session', () => {
  it('signs in from any state', () => {
    for (const from of [
      initialAuthState,
      { status: 'unauthenticated', reason: 'expired' },
      { status: 'error', message: 'x' },
    ] as AuthState[]) {
      expect(run([{ type: 'signed-in', user }], from)).toEqual({ status: 'authenticated', user });
    }
  });

  it('remembers that the user signed out on purpose', () => {
    expect(run([{ type: 'restored', user }, { type: 'signed-out' }])).toEqual({
      status: 'unauthenticated',
      reason: 'signed-out',
    });
  });

  it('marks a lost session as expired only for a signed-in user', () => {
    expect(run([{ type: 'restored', user }, { type: 'session-lost' }])).toEqual({
      status: 'unauthenticated',
      reason: 'expired',
    });
    // While loading, the restore result decides; when already signed out there is nothing to lose.
    expect(run([{ type: 'session-lost' }]).status).toBe('loading');
    expect(run([{ type: 'signed-out' }, { type: 'session-lost' }])).toEqual({
      status: 'unauthenticated',
      reason: 'signed-out',
    });
  });

  it('is deterministic: the same actions always give the same state', () => {
    const actions: AuthAction[] = [
      { type: 'restored', user },
      { type: 'session-lost' },
      { type: 'signed-in', user },
    ];
    expect(run(actions)).toEqual(run(actions));
  });
});
