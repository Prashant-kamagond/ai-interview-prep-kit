import type { ReactNode } from 'react';
import { ProtectedShell } from '../../features/auth/ProtectedShell';

export default function AppLayout({ children }: { children: ReactNode }) {
  return <ProtectedShell>{children}</ProtectedShell>;
}
