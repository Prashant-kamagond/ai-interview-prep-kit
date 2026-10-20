import { useId, type InputHTMLAttributes, type Ref } from 'react';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  /** Shown under the field. Linked to it for screen readers. */
  hint?: string;
  /** When set the field is marked invalid and the message is linked to it. */
  error?: string | undefined;
  ref?: Ref<HTMLInputElement>;
}

/** A labelled input whose hint and error are programmatically tied to it. */
export function TextField({ label, hint, error, className = '', ref, ...rest }: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <input
        {...rest}
        ref={ref}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`block min-h-11 w-full rounded-md border bg-white px-3 text-base text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo-700 ${
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
