'use client';

import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { describeOperation } from './describe';
import type { BuilderStoreState } from './state';
import type { BuilderStore } from './store';

/** Always-visible save state, announced politely when it changes. */
export function SaveStatus({ state, store }: { state: BuilderStoreState; store: BuilderStore }) {
  const text: Record<BuilderStoreState['status'], string> = {
    synced: 'All changes saved',
    dirty: 'Unsaved changes — saving shortly',
    saving: 'Saving…',
    failed: 'Could not save',
    conflict: 'Changed elsewhere',
  };
  return (
    <p
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center gap-2 text-sm text-slate-700"
    >
      <span
        aria-hidden="true"
        className={`inline-block size-2.5 rounded-full ${
          state.status === 'synced'
            ? 'bg-emerald-600'
            : state.status === 'saving' || state.status === 'dirty'
              ? 'bg-amber-500'
              : 'bg-red-600'
        }`}
      />
      <span>{text[state.status]}</span>
      {state.status === 'dirty' ? (
        <Button variant="secondary" onClick={() => store.flush()}>
          Save now
        </Button>
      ) : null}
    </p>
  );
}

/** A failed save: say what happened, say the edits are kept, and offer what can actually help. */
export function FailureBanner({ state, store }: { state: BuilderStoreState; store: BuilderStore }) {
  const failure = state.failure;
  if (state.status !== 'failed' || !failure) return null;
  return (
    <Alert
      tone="error"
      title="Your changes have not been saved"
      action={
        <div className="flex flex-wrap gap-2">
          {failure.retryable ? <Button onClick={() => store.retry()}>Retry saving</Button> : null}
          <Button variant="secondary" onClick={() => store.discardAll()}>
            Discard my unsaved changes
          </Button>
        </div>
      }
    >
      {failure.message} Your {state.pending.length} unsaved{' '}
      {state.pending.length === 1 ? 'edit is' : 'edits are'} kept on this page.
    </Alert>
  );
}

/**
 * Someone (or another tab) changed the kit while these edits were open. Nothing is sent until the user
 * chooses: reapply the edits to the new version, or discard them.
 */
export function ConflictPanel({ state, store }: { state: BuilderStoreState; store: BuilderStore }) {
  const conflict = state.conflict;
  if (state.status !== 'conflict' || !conflict) return null;
  const failing = conflict.replayFailure;
  return (
    <Alert tone="error" title="This kit was changed somewhere else">
      <p>
        The kit is now at version {conflict.current.version}; your edits were made on version{' '}
        {state.server.version}. Nothing of yours has been lost or sent, and the editor is paused
        until you choose.
      </p>
      <p className="mt-2 font-medium">Your unsaved edits ({state.pending.length}):</p>
      <ol className="list-decimal pl-5">
        {state.pending.map((op, i) => (
          <li key={i} className={failing?.index === i ? 'font-semibold text-red-900' : ''}>
            {describeOperation(op)}
            {failing?.index === i ? ' — cannot be applied to the new version' : ''}
          </li>
        ))}
      </ol>
      {failing ? (
        <p className="mt-2">
          Edit {failing.index + 1} no longer applies: {failing.message}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {failing ? (
          <Button onClick={() => store.discardFailing()}>
            Discard that edit and reapply the rest
          </Button>
        ) : (
          <Button onClick={() => store.reapply()}>Reapply my edits to the new version</Button>
        )}
        <Button variant="secondary" onClick={() => store.discardAll()}>
          Discard my edits and use the new version
        </Button>
      </div>
    </Alert>
  );
}

/** Edits saved by an earlier visit that never reached the server. */
export function DraftPrompt({
  count,
  onRestore,
  onDiscard,
}: {
  count: number;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  return (
    <Alert
      tone="info"
      title="You have unsaved edits from an earlier visit"
      action={
        <div className="flex flex-wrap gap-2">
          <Button onClick={onRestore}>Restore my edits</Button>
          <Button variant="secondary" onClick={onDiscard}>
            Discard them
          </Button>
        </div>
      }
    >
      {count} {count === 1 ? 'edit was' : 'edits were'} never saved. Restoring checks them against
      the kit as it is now, and applies none of them if any no longer fits.
    </Alert>
  );
}
