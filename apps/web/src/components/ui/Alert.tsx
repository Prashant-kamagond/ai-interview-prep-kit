import type { ReactNode, Ref } from 'react';

type Tone = 'error' | 'info' | 'success';

const TONES: Record<Tone, string> = {
  error: 'border-red-300 bg-red-50 text-red-900',
  info: 'border-sky-300 bg-sky-50 text-sky-900',
  success: 'border-emerald-300 bg-emerald-50 text-emerald-900',
};

export interface AlertProps {
  tone?: Tone;
  title?: string;
  children: ReactNode;
  /** Optional action, for example a retry button. */
  action?: ReactNode;
  /** Lets a caller move keyboard focus to the message after a failed submit. */
  ref?: Ref<HTMLDivElement>;
}

/** An error is announced immediately (role="alert"); other messages politely (role="status"). */
export function Alert({ tone = 'info', title, children, action, ref }: AlertProps) {
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-md border p-3 text-sm ${TONES[tone]}`}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      <div>{children}</div>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
