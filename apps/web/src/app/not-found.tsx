import Link from 'next/link';
import { EmptyState } from '../components/ui/EmptyState';

export default function NotFound() {
  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex min-h-screen max-w-xl items-center justify-center p-6"
    >
      <EmptyState
        title="Page not found"
        action={
          <Link href="/kits" className="font-medium text-indigo-800 underline underline-offset-2">
            Go to your kits
          </Link>
        }
      >
        There is nothing at this address.
      </EmptyState>
    </main>
  );
}
