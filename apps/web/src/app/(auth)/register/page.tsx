import type { Metadata } from 'next';
import { CredentialsForm } from '../../../features/auth/CredentialsForm';

export const metadata: Metadata = { title: 'Create account' };

export default function Page() {
  return <CredentialsForm mode="register" />;
}
