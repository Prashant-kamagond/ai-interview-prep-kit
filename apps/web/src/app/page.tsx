import { redirect } from 'next/navigation';

// The signed-in landing page decides what to show; a signed-out visitor is sent to sign in from there.
export default function HomePage(): never {
  redirect('/kits');
}
