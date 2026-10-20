import Link from 'next/link';
import type { ComponentProps } from 'react';

type Variant = 'primary' | 'secondary';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-indigo-700 text-white hover:bg-indigo-800',
  secondary: 'border border-slate-300 bg-white text-slate-900 hover:bg-slate-100',
};

/** A link that looks like a Button, for navigation that should stand out. */
export function LinkButton({
  variant = 'primary',
  className = '',
  ...rest
}: ComponentProps<typeof Link> & { variant?: Variant }) {
  return (
    <Link
      {...rest}
      className={`inline-flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-700 ${VARIANTS[variant]} ${className}`}
    />
  );
}
