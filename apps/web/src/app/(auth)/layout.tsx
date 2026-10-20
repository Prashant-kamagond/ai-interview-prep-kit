import type { ReactNode } from 'react';
import { GuestOnly } from '../../features/auth/GuestOnly';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <GuestOnly>
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto flex min-h-screen w-full max-w-md items-center px-4 py-10"
      >
        <div className="w-full rounded-lg border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          {children}
        </div>
      </main>
    </GuestOnly>
  );
}
