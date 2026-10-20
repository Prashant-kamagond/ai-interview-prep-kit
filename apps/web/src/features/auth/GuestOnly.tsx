'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { useAuth } from '../../lib/auth/AuthProvider';
import { safeNextPath } from '../../lib/navigation';

/**
 * Wraps the sign-in and registration pages. Someone who is already signed in is sent on (to the page
 * they were heading for, if it is a safe in-app path); while the session is being checked nothing is
 * shown, so the form never flashes for a signed-in user.
 */
export function GuestOnly({ children }: { children: ReactNode }) {
  const { state, retry } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (state.status !== 'authenticated') return;
    router.replace(safeNextPath(new URLSearchParams(window.location.search).get('next')));
  }, [state.status, router]);

  if (state.status === 'unauthenticated') return <>{children}</>;
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
          label={
            state.status === 'authenticated' ? 'Taking you to your kits…' : 'Checking your session…'
          }
        />
      )}
    </main>
  );
}
