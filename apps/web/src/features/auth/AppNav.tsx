'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import type { User } from '../../lib/api/auth';
import type { ApiError } from '../../lib/api/client';
import { useAuth } from '../../lib/auth/AuthProvider';

/** The top bar: where you are, who you are, and a way out. Wraps on a phone instead of overflowing. */
export function AppNav({ user }: { user: User }) {
  const { logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    setBusy(true);
    setError(null);
    try {
      await logout();
    } catch (err) {
      // Never pretend the session ended if the server could not be told.
      setError((err as ApiError).message || 'Could not sign out. Please try again.');
      setBusy(false);
    }
  }

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <Link href="/kits" className="text-lg font-semibold text-slate-900">
          AI Interview Prep Kit
        </Link>
        <nav aria-label="Main" className="flex flex-wrap items-center gap-3">
          <Link
            href="/kits"
            className="rounded-md px-2 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100"
          >
            Your kits
          </Link>
          <span className="max-w-[16rem] truncate text-sm text-slate-600" title={user.email}>
            {user.email}
          </span>
          <Button variant="secondary" onClick={signOut} loading={busy}>
            {busy ? 'Signing out…' : 'Sign out'}
          </Button>
        </nav>
      </div>
      {error ? (
        <div className="mx-auto w-full max-w-5xl px-4 pb-3 sm:px-6">
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}
    </header>
  );
}
