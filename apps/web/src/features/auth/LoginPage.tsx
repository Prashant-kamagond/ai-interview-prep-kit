'use client';

import { useSearchParams } from 'next/navigation';
import { CredentialsForm } from './CredentialsForm';

/** Reads `?expired=1` so a user whose session ended is told why they are looking at the sign-in form. */
export function LoginPage() {
  const params = useSearchParams();
  return (
    <CredentialsForm
      mode="login"
      notice={
        params.get('expired') === '1'
          ? 'Your session expired. Sign in again to continue.'
          : undefined
      }
    />
  );
}
