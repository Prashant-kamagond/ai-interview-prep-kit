import type { BuilderDocumentResponse, BuilderOperation } from '@trao/contracts';
import { applyOperation, applyOperations, type BuilderDocument } from '@trao/core';

/**
 * The editor's local state, as a pure reducer over the builder's own pure operations
 * (`@trao/core`). Nothing here re-implements an editing rule: an edit is applied by calling the same
 * `applyOperation` the server runs, so the screen and the server cannot disagree about what an
 * operation does.
 *
 * Shape of the idea:
 *   server   the last document the server confirmed (the base version edits are sent against)
 *   local    server + every pending operation, applied in order: what the user sees
 *   pending  operations the server has not confirmed yet, oldest first
 *   inFlight how many of the first `pending` operations are in a request right now
 *
 * An edit made while a request is in flight only appends to `pending`. When the response arrives the
 * first `inFlight` operations are retired and the rest are replayed on the new server document, so
 * nothing the user typed in the meantime can be lost.
 */

export type SaveFailureKind = 'network' | 'server' | 'rejected' | 'session' | 'not-found';

export interface SaveFailure {
  kind: SaveFailureKind;
  message: string;
  /** Whether sending the same operations again can help. */
  retryable: boolean;
}

export interface ReplayFailure {
  /** Position in `pending` (0-based) of the operation that no longer applies. */
  index: number;
  message: string;
}

export type SaveStatus = 'synced' | 'dirty' | 'saving' | 'failed' | 'conflict';

export interface BuilderStoreState {
  server: BuilderDocumentResponse;
  local: BuilderDocument;
  pending: BuilderOperation[];
  inFlight: number;
  status: SaveStatus;
  failure: SaveFailure | null;
  /** Set while the server holds a newer version than the edits were made against. */
  conflict: { current: BuilderDocumentResponse; replayFailure: ReplayFailure | null } | null;
  /** The last edit that could not be applied locally (it was not queued). */
  notice: string | null;
}

export type BuilderAction =
  | { type: 'edit'; operation: BuilderOperation }
  | { type: 'restore'; operations: unknown[] }
  | { type: 'save-started' }
  | { type: 'save-succeeded'; document: BuilderDocumentResponse }
  | { type: 'save-conflict'; current: BuilderDocumentResponse }
  | { type: 'save-failed'; failure: SaveFailure }
  | { type: 'retry' }
  | { type: 'adopt'; document: BuilderDocumentResponse }
  | { type: 'reapply' }
  | { type: 'discard-failing' }
  | { type: 'discard-all' }
  | { type: 'dismiss-notice' };

export const toDocument = (response: BuilderDocumentResponse): BuilderDocument => ({
  kit: response.kit,
  state: response.builder,
});

export function initialState(server: BuilderDocumentResponse): BuilderStoreState {
  return {
    server,
    local: toDocument(server),
    pending: [],
    inFlight: 0,
    status: 'synced',
    failure: null,
    conflict: null,
    notice: null,
  };
}

/** JSON with sorted keys, so two documents compare equal whatever order their keys were built in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

const sameDocument = (a: BuilderDocument, b: BuilderDocument) => canonical(a) === canonical(b);

function afterConfirm(
  state: BuilderStoreState,
  document: BuilderDocumentResponse,
): BuilderStoreState {
  const rest = state.pending.slice(state.inFlight);
  const base = toDocument(document);
  if (rest.length === 0) {
    return {
      ...state,
      server: document,
      local: base,
      pending: [],
      inFlight: 0,
      status: 'synced',
      failure: null,
      conflict: null,
    };
  }
  // Edits made while the request was in flight go on top of the confirmed document.
  const replay = applyOperations(base, rest);
  if (!replay.ok) {
    return {
      ...state,
      server: document,
      pending: rest,
      inFlight: 0,
      status: 'conflict',
      failure: null,
      conflict: {
        current: document,
        replayFailure: { index: replay.error.operation_index ?? 0, message: replay.error.message },
      },
    };
  }
  return {
    ...state,
    server: document,
    local: replay.document,
    pending: rest,
    inFlight: 0,
    status: 'dirty',
    failure: null,
    conflict: null,
  };
}

/** Tries to put the pending operations on the server's current document, all or nothing. */
function replayOnCurrent(state: BuilderStoreState): BuilderStoreState {
  const current = state.conflict?.current;
  if (!current) return state;
  const replay = applyOperations(toDocument(current), state.pending);
  if (!replay.ok) {
    return {
      ...state,
      conflict: {
        current,
        replayFailure: { index: replay.error.operation_index ?? 0, message: replay.error.message },
      },
    };
  }
  return {
    ...state,
    server: current,
    local: replay.document,
    status: state.pending.length > 0 ? 'dirty' : 'synced',
    failure: null,
    conflict: null,
  };
}

export function builderReducer(state: BuilderStoreState, action: BuilderAction): BuilderStoreState {
  switch (action.type) {
    case 'edit': {
      // While the user decides about a conflict the document is not editable.
      if (state.status === 'conflict') return state;
      const result = applyOperation(state.local, action.operation);
      if (!result.ok) return { ...state, notice: result.error.message };
      return {
        ...state,
        local: result.document,
        pending: [...state.pending, action.operation],
        status: state.status === 'synced' ? 'dirty' : state.status,
        notice: null,
      };
    }

    case 'restore': {
      if (state.pending.length > 0 || state.status !== 'synced') return state;
      const result = applyOperations(state.local, action.operations);
      if (!result.ok) {
        return {
          ...state,
          notice: `Your earlier unsaved edits could not be restored: ${result.error.message}`,
        };
      }
      return {
        ...state,
        local: result.document,
        pending: action.operations as BuilderOperation[],
        status: action.operations.length > 0 ? 'dirty' : 'synced',
        notice: null,
      };
    }

    case 'save-started':
      // Only unsaved edits that nobody is sending, and never from a failure or a conflict.
      if (state.status !== 'dirty' || state.inFlight > 0 || state.pending.length === 0)
        return state;
      return { ...state, inFlight: state.pending.length, status: 'saving', failure: null };

    case 'save-succeeded':
      if (state.inFlight === 0) return state; // a response nobody is waiting for
      return afterConfirm(state, action.document);

    case 'save-conflict': {
      if (state.inFlight === 0) return state;
      // A request whose answer was lost may still have been applied. Because the operations are pure,
      // that can be checked: if applying what was sent to the base we had gives exactly the document
      // the server now holds (one version later), the save did succeed and must not be repeated.
      const sent = state.pending.slice(0, state.inFlight);
      const replay = applyOperations(toDocument(state.server), sent);
      if (
        replay.ok &&
        action.current.version === state.server.version + 1 &&
        sameDocument(replay.document, toDocument(action.current))
      ) {
        return afterConfirm(state, action.current);
      }
      return {
        ...state,
        inFlight: 0,
        status: 'conflict',
        failure: null,
        conflict: { current: action.current, replayFailure: null },
      };
    }

    case 'save-failed':
      return { ...state, inFlight: 0, status: 'failed', failure: action.failure };

    case 'retry':
      if (state.status !== 'failed' || !state.failure?.retryable) return state;
      return { ...state, status: 'dirty', failure: null };

    case 'adopt':
      // Loading a newer server version is only allowed when nothing local could be lost: no unsaved
      // edits, nothing in flight, no conflict or failure to resolve. An older or equal version is ignored.
      if (state.status !== 'synced' || state.pending.length > 0 || state.inFlight > 0) return state;
      if (action.document.version <= state.server.version) return state;
      return initialState(action.document);

    case 'reapply':
      return state.status === 'conflict' ? replayOnCurrent(state) : state;

    case 'discard-failing': {
      const failing = state.conflict?.replayFailure;
      if (state.status !== 'conflict' || !failing) return state;
      const pending = state.pending.filter((_, i) => i !== failing.index);
      return replayOnCurrent({ ...state, pending });
    }

    case 'discard-all': {
      if (state.status !== 'conflict' && state.status !== 'failed') return state;
      const server = state.conflict?.current ?? state.server;
      return {
        ...state,
        server,
        local: toDocument(server),
        pending: [],
        inFlight: 0,
        status: 'synced',
        failure: null,
        conflict: null,
        notice: null,
      };
    }

    case 'dismiss-notice':
      return state.notice === null ? state : { ...state, notice: null };
  }
}
