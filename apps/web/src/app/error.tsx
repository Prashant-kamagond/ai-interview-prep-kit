'use client';

import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';

/** Anything that throws while rendering ends up here instead of a blank page. No error text is shown. */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex min-h-screen max-w-md items-center justify-center p-6"
    >
      <Alert
        tone="error"
        title="Something went wrong"
        action={
          <Button variant="secondary" onClick={reset}>
            Try again
          </Button>
        }
      >
        This page could not be shown. Your data is safe. Try again, or reload the page.
      </Alert>
    </main>
  );
}
