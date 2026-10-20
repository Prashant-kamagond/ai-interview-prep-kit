import { useId, type Ref, type TextareaHTMLAttributes } from 'react';

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label: string;
  hint?: string;
  error?: string | undefined;
  ref?: Ref<HTMLTextAreaElement>;
}

/** The multi-line sibling of TextField: same label, hint and error wiring. */
export function TextArea({ label, hint, error, className = '', ref, ...rest }: TextAreaProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <textarea
        {...rest}
        ref={ref}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`block min-h-40 w-full rounded-md border bg-white px-3 py-2 text-base text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo-700 ${
          error ? 'border-red-600' : 'border-slate-400'
        } ${className}`}
      />
      {hint ? (
        <p id={hintId} className="text-sm text-slate-600">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
