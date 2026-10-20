import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Spinner } from '../../../../components/ui/Spinner';
import { CreateKitPage } from '../../../../features/create/CreateKitPage';

export const metadata: Metadata = { title: 'Create a kit' };

export default function NewKitPage() {
  // useSearchParams needs a Suspense boundary so the rest of the page can be prerendered.
  return (
    <Suspense fallback={<Spinner showLabel label="Loading…" />}>
      <CreateKitPage />
    </Suspense>
  );
}
