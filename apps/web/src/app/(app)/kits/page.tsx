import type { Metadata } from 'next';
import { KitList } from '../../../features/kits/KitList';

export const metadata: Metadata = { title: 'Your kits' };

export default function KitsPage() {
  return <KitList />;
}
