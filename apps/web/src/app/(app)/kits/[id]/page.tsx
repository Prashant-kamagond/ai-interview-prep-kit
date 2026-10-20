import type { Metadata } from 'next';
import { BuilderEditor } from '../../../../features/builder/BuilderEditor';

export const metadata: Metadata = { title: 'Edit kit' };

export default async function KitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BuilderEditor id={id} />;
}
