'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ItemMeta, Requirement } from '@trao/contracts';
import { Button } from '../../components/ui/Button';

/** What the builder knows about an item, shown as small labels so the user can see it. */
export function Badges({
  meta,
  extra,
}: {
  meta: Pick<ItemMeta, 'origin' | 'edited' | 'pinned'> | undefined;
  extra?: ReactNode;
}) {
  if (!meta) return null;
  const labels = [
    meta.origin === 'manual' ? 'Added by you' : null,
    meta.edited ? 'Edited' : null,
    meta.pinned ? 'Pinned' : null,
  ].filter(Boolean);
  if (labels.length === 0 && !extra) return null;
  return (
    <ul aria-label="Item status" className="flex flex-wrap gap-1.5 text-xs">
      {labels.map((label) => (
        <li
          key={label}
          className="rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-slate-800"
        >
          {label}
        </li>
      ))}
      {extra}
    </ul>
  );
}

/** A toggle: pinned items are kept as they are when the kit is regenerated later. */
export function PinButton({
  pinned,
  label,
  onToggle,
  disabled,
}: {
  pinned: boolean;
  label: string;
  onToggle: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="secondary"
      aria-pressed={pinned}
      aria-label={`${pinned ? 'Unpin' : 'Pin'} ${label}`}
      disabled={disabled}
      onClick={() => onToggle(!pinned)}
    >
      {pinned ? 'Unpin' : 'Pin'}
    </Button>
  );
}

/** Deleting asks first. The safe answer (Cancel) is the one that receives focus. */
export function ConfirmDelete({
  label,
  consequence,
  onConfirm,
  returnFocusTo,
  disabled,
}: {
  label: string;
  consequence?: string;
  onConfirm: () => void;
  /** The id of an element to focus once the item is gone (its own button no longer exists). */
  returnFocusTo?: string;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);
  // After Cancel the Delete button comes back and gets focus again, so keyboard users keep their place.
  useEffect(() => {
    if (wasAsking.current && !asking) triggerRef.current?.focus();
    wasAsking.current = asking;
  }, [asking]);
  if (!asking) {
    return (
      <Button
        ref={triggerRef}
        variant="secondary"
        aria-label={`Delete ${label}`}
        disabled={disabled}
        onClick={() => {
          setAsking(true);
          // focus after the confirmation has rendered
          setTimeout(() => cancelRef.current?.focus(), 0);
        }}
      >
        Delete
      </Button>
    );
  }
  return (
    <div
      role="group"
      aria-label={`Confirm deleting ${label}`}
      className="flex flex-wrap items-center gap-2 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-950"
    >
      <span>
        Delete {label}? {consequence ?? 'This cannot be undone here.'}
      </span>
      <Button
        variant="danger"
        onClick={() => {
          wasAsking.current = false; // the item is going away; focus goes to returnFocusTo instead
          setAsking(false);
          onConfirm();
          if (returnFocusTo) setTimeout(() => document.getElementById(returnFocusTo)?.focus(), 0);
        }}
      >
        Yes, delete
      </Button>
      <Button ref={cancelRef} variant="secondary" onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </div>
  );
}

export function SelectField<T extends string | number>({
  label,
  value,
  onChange,
  options,
  disabled,
  className = '',
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={`space-y-1 ${className}`}>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <select
        id={id}
        value={String(value)}
        disabled={disabled}
        onChange={(e) => {
          const picked = options.find((o) => String(o.value) === e.target.value);
          if (picked) onChange(picked.value);
        }}
        className="block min-h-11 w-full rounded-md border border-slate-400 bg-white px-2 text-base text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo-700"
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Which requirements a question or flashcard relates to. */
export function RequirementPicker({
  legend,
  requirements,
  selected,
  onChange,
  disabled,
}: {
  legend: string;
  requirements: readonly Requirement[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  if (requirements.length === 0) {
    return <p className="text-sm text-slate-600">There are no requirements to relate this to.</p>;
  }
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium text-slate-800">{legend}</legend>
      <div className="grid gap-1 sm:grid-cols-2">
        {requirements.map((r) => (
          <label
            key={r.id}
            className="flex min-h-11 items-start gap-2 py-1 text-sm text-slate-900 [overflow-wrap:anywhere]"
          >
            <input
              type="checkbox"
              className="mt-1 size-4"
              disabled={disabled}
              checked={selected.includes(r.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked ? [...selected, r.id] : selected.filter((id) => id !== r.id),
                )
              }
            />
            <span>
              <code>{r.id}</code> {r.text}{' '}
              <span className="text-slate-600">
                ({r.priority === 'must' ? 'must-have' : 'nice-to-have'})
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Polite announcements for actions with no other visible result (such as moving an item). */
export function LiveRegion({ message }: { message: string }) {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {message}
    </p>
  );
}

/**
 * Puts keyboard focus back on the control that opened a form once the form closes (applied or
 * cancelled). Controls opt in with `data-focus-key`; `active` is the key of the open form, or null.
 */
export function useFocusReturn(active: string | null): void {
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (active !== null) {
      last.current = active;
      return;
    }
    const key = last.current;
    last.current = null;
    if (key === null) return;
    const safe = key.replace(/["\\]/g, '');
    document.querySelector<HTMLElement>(`[data-focus-key="${safe}"]`)?.focus();
  }, [active]);
}

/**
 * After an action that moves an item, the button that was pressed may be gone or disabled (a question
 * that reached the end cannot move further that way). Call the returned function with the keys of the
 * controls to try, in order, before making the change; after the next render the first one that
 * exists and is enabled receives keyboard focus.
 */
export function useRestoreFocus(): (...keys: string[]) => void {
  const wanted = useRef<string[] | null>(null);
  useEffect(() => {
    const keys = wanted.current;
    if (!keys) return;
    wanted.current = null;
    for (const key of keys) {
      const safe = key.replace(/["\\]/g, '');
      const el = document.querySelector<HTMLButtonElement>(`[data-focus-key="${safe}"]`);
      if (el && !el.disabled) {
        el.focus();
        return;
      }
    }
  });
  return (...keys: string[]) => {
    wanted.current = keys;
  };
}
