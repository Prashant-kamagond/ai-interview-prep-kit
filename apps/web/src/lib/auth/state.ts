import type { User } from '../api/auth';
import type { ApiError } from '../api/client';

/**
 * Who is using the app, as a small state machine. It is a plain reducer so every transition can be
 * tested without a browser.
 *
 *   loading ──restored──► authenticated ──session-lost──► unauthenticated (expired)
 *      │                       │  ▲                             │
 *      │                  signed-out  signed-in ◄───────────────┘
 *      ├─restore-failed(401)─► unauthenticated (none)
 *      └─restore-failed(other)─► error ──retry──► loading
 */
export type SignedOutReason = 'none' | 'signed-out' | 'expired';

export type AuthState =
  | { status: 'loading' }
  | { status: 'authenticated'; user: User }
  | { status: 'unauthenticated'; reason: SignedOutReason }
  | { status: 'error'; message: string };

export type AuthAction =
  | { type: 'restored'; user: User }
  | { type: 'restore-failed'; error: ApiError }
  | { type: 'signed-in'; user: User }
  | { type: 'signed-out' }
  | { type: 'session-lost' }
  | { type: 'retry' };

export const initialAuthState: AuthState = { status: 'loading' };

export function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'restored':
      // A late answer must not undo a sign-in or sign-out that happened in the meantime.
      return state.status === 'loading' ? { status: 'authenticated', user: action.user } : state;
    case 'restore-failed':
      if (state.status !== 'loading') return state;
      return action.error.status === 401
        ? { status: 'unauthenticated', reason: 'none' }
        : { status: 'error', message: action.error.message };
    case 'signed-in':
      return { status: 'authenticated', user: action.user };
    case 'signed-out':
      return { status: 'unauthenticated', reason: 'signed-out' };
    case 'session-lost':
      // Only a signed-in user can "lose" a session; while loading, the restore result decides.
      return state.status === 'authenticated'
        ? { status: 'unauthenticated', reason: 'expired' }
        : state;
    case 'retry':
      return state.status === 'error' ? { status: 'loading' } : state;
  }
}
