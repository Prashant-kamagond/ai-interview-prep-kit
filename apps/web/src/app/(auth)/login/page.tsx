import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginPage } from '../../../features/auth/LoginPage';

export const metadata: Metadata = { title: 'Sign in' };

// useSearchParams needs a Suspense boundary so the rest of the page can be prerendered.
export default function Page() {
  return (
    <Suspense fallback={null}>
      <LoginPage />
    </Suspense>
  );
}
