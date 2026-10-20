import type { Metadata } from 'next';
import { PracticePage } from '../../../../../features/practice/PracticePage';

export const metadata: Metadata = { title: 'Practise flashcards' };

export default async function PracticeRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PracticePage id={id} />;
}
