'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ReactNode,
} from 'react';
import type { LoginInput, RegisterInput } from '@trao/contracts';
import type { AuthApi } from '../api/auth';
import type { ApiError } from '../api/client';
import { authApi as defaultAuthApi, onSessionLost } from '../api/default';
import { authReducer, initialAuthState, type AuthState } from './state';

export interface AuthContextValue {
  state: AuthState;
  /** Resolves when signed in; rejects with an ApiError the form can show. */
  login(input: LoginInput): Promise<void>;
  register(input: RegisterInput): Promise<void>;
  /** Rejects if the server could not be told, so the UI never pretends the session ended. */
  logout(): Promise<void>;
  /** Tries to restore the session again after a network or server failure. */
  retry(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  children: ReactNode;
  /** Replaced in tests. */
  api?: AuthApi;
  subscribe?: (listener: (error: ApiError) => void) => () => void;
}

export function AuthProvider({
  children,
  api = defaultAuthApi,
  subscribe = onSessionLost,
}: AuthProviderProps) {
  const [state, dispatch] = useReducer(authReducer, initialAuthState);
  const [attempt, setAttempt] = useState(0);

  // On load (and on retry) ask the server who we are. The cookie is HttpOnly, so this is the only way to know.
  useEffect(() => {
    const controller = new AbortController();
    api
      .me({ signal: controller.signal })
      .then((user) => dispatch({ type: 'restored', user }))
      .catch((error: ApiError) => {
        if (error.code === 'ABORTED') return;
        dispatch({ type: 'restore-failed', error });
      });
    return () => controller.abort();
  }, [api, attempt]);

  // Any later request that finds the session gone moves the whole app to "signed out (expired)".
  useEffect(() => subscribe(() => dispatch({ type: 'session-lost' })), [subscribe]);

  const login = useCallback(
    async (input: LoginInput) => {
      dispatch({ type: 'signed-in', user: await api.login(input) });
    },
    [api],
  );
  const register = useCallback(
    async (input: RegisterInput) => {
      dispatch({ type: 'signed-in', user: await api.register(input) });
    },
    [api],
  );
  const logout = useCallback(async () => {
    await api.logout();
    dispatch({ type: 'signed-out' });
  }, [api]);
  const retry = useCallback(() => {
    dispatch({ type: 'retry' });
    setAttempt((n) => n + 1);
  }, []);

  const value = useMemo(
    () => ({ state, login, register, logout, retry }),
    [state, login, register, logout, retry],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
