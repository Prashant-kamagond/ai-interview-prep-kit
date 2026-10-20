'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { useAuth } from '../../lib/auth/AuthProvider';
import { loginHref } from '../../lib/navigation';
import { AppNav } from './AppNav';

/**
 * Everything behind sign-in lives inside this shell. It shows nothing but a status while the session is
 * checked, sends a signed-out visitor to the sign-in page (remembering where they were going, unless
 * they chose to sign out), and says plainly when a session expired or the server could not be reached.
 */
export function ProtectedShell({ children }: { children: ReactNode }) {
  const { state, retry } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (state.status !== 'unauthenticated') return;
    if (state.reason === 'signed-out') {
      router.replace('/login');
      return;
    }
    const returnTo = `${pathname}${window.location.search}`;
    router.replace(loginHref(returnTo, state.reason === 'expired' ? { expired: '1' } : {}));
  }, [state, pathname, router]);

  if (state.status === 'authenticated') {
    return (
      <>
        <AppNav user={state.user} />
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
          {children}
        </main>
      </>
    );
  }

  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex min-h-screen max-w-md items-center justify-center p-6"
    >
      {state.status === 'error' ? (
        <Alert
          tone="error"
          title="Could not check your session"
          action={
            <Button variant="secondary" onClick={retry}>
              Try again
            </Button>
          }
        >
          {state.message}
        </Alert>
      ) : (
        <Spinner
          showLabel
          label={state.status === 'loading' ? 'Checking your session…' : 'Taking you to sign in…'}
        />
      )}
    </main>
  );
}
