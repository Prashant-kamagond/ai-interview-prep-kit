import type { BuilderDocumentResponse, BuilderOperation } from '@trao/contracts';
import { ApiError } from '../../lib/api/client';
import { VersionConflictError, type BuilderApi } from '../../lib/api/builder';
import {
  builderReducer,
  initialState,
  type BuilderAction,
  type BuilderStoreState,
  type SaveFailure,
} from './state';

export const DEFAULT_DEBOUNCE_MS = 800;

/** Where unsaved operations are kept so a reload or an expired session does not lose them. */
export interface DraftStorage {
  read(kitId: string): unknown[] | null;
  write(kitId: string, operations: BuilderOperation[]): void;
}

export const sessionDrafts: DraftStorage = {
  read(kitId) {
    try {
      const raw = window.sessionStorage.getItem(`trao:builder-draft:${kitId}`);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
    } catch {
      return null;
    }
  },
  write(kitId, operations) {
    try {
      const key = `trao:builder-draft:${kitId}`;
      if (operations.length === 0) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, JSON.stringify(operations));
    } catch {
      // A draft is a safety net; the edits still live in the page if storage is unavailable.
    }
  },
};

/** What the user is told when a save fails, in plain words. Raw error text never reaches the screen. */
export function failureFor(error: unknown): SaveFailure {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return { kind: 'session', retryable: false, message: 'Your session ended. Sign in again.' };
    }
    if (error.status === 404) {
      return {
        kind: 'not-found',
        retryable: false,
        message: 'This kit no longer exists in your account.',
      };
    }
    if (error.status === 0 || error.status === 429) {
      return { kind: 'network', retryable: true, message: error.message };
    }
    if (error.status >= 500 || error.code === 'BAD_RESPONSE') {
      return {
        kind: 'server',
        retryable: true,
        message: 'The server had a problem saving your changes.',
      };
    }
    return { kind: 'rejected', retryable: false, message: error.message };
  }
  return { kind: 'server', retryable: true, message: 'Something went wrong while saving.' };
}

export interface BuilderStoreOptions {
  debounceMs?: number;
  drafts?: DraftStorage;
}

/**
 * Owns one open kit: the reducer state, the debounce timer and the one request that may be in flight.
 * It is plain TypeScript so it can be tested without a browser; React only subscribes to it.
 *
 * Guarantees:
 *  - at most one save request at a time, so responses cannot arrive out of order;
 *  - a request is sent only from `dirty`, never from `failed` or `conflict`: after a failure the user
 *    retries, after a conflict the user chooses (nothing is resubmitted automatically);
 *  - each request carries the server version of the last confirmed document and the operations that
 *    were pending when it started; edits made meanwhile wait for the response (see state.ts).
 */
export class BuilderStore {
  private state: BuilderStoreState;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  private readonly drafts: DraftStorage | undefined;

  constructor(
    readonly kitId: string,
    private readonly api: Pick<BuilderApi, 'applyOperations'>,
    initial: BuilderDocumentResponse,
    options: BuilderStoreOptions = {},
  ) {
    this.state = initialState(initial);
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.drafts = options.drafts;
  }

  getState = (): BuilderStoreState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private dispatch(action: BuilderAction): void {
    const before = this.state;
    const next = builderReducer(before, action);
    if (next === before) return;
    this.state = next;
    if (next.pending !== before.pending) this.drafts?.write(this.kitId, next.pending);
    for (const listener of [...this.listeners]) listener();
    this.arm();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.state.status !== 'dirty') return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, this.debounceMs);
  }

  edit(operation: BuilderOperation): void {
    this.dispatch({ type: 'edit', operation });
  }

  /** Puts back operations saved by an earlier visit, if they still apply. */
  restore(operations: unknown[]): void {
    this.dispatch({ type: 'restore', operations });
  }

  /** Saves now instead of waiting for the debounce (for example when leaving the page). */
  flush(): void {
    if (this.state.status === 'dirty') void this.save();
  }

  retry(): void {
    this.dispatch({ type: 'retry' });
    this.flush();
  }

  /**
   * Shows a newer server version (for example after a regeneration), but only if nothing unsaved
   * would be lost. Returns whether the document was replaced.
   */
  adopt(document: BuilderDocumentResponse): boolean {
    const before = this.state;
    this.dispatch({ type: 'adopt', document });
    return this.state !== before;
  }

  /**
   * Resolves true once everything is saved, and false if saving cannot finish without the user (a
   * failure or a conflict). Used to "save first" before an action that needs the server up to date.
   */
  whenSynced(): Promise<boolean> {
    this.flush();
    const settled = (): boolean | null => {
      const { status } = this.state;
      if (status === 'synced') return true;
      if (status === 'failed' || status === 'conflict') return false;
      return null;
    };
    const now = settled();
    if (now !== null) return Promise.resolve(now);
    return new Promise((resolve) => {
      const off = this.subscribe(() => {
        const result = settled();
        if (result === null) return;
        off();
        resolve(result);
      });
    });
  }

  reapply(): void {
    this.dispatch({ type: 'reapply' });
  }
  discardFailing(): void {
    this.dispatch({ type: 'discard-failing' });
  }
  discardAll(): void {
    this.dispatch({ type: 'discard-all' });
  }
  dismissNotice(): void {
    this.dispatch({ type: 'dismiss-notice' });
  }

  /** The page is going away. Stop waiting, but do not abandon edits that are still unsaved. */
  detach(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
  }

  private async save(): Promise<void> {
    if (this.state.status !== 'dirty' || this.state.inFlight > 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dispatch({ type: 'save-started' });
    const { inFlight, pending, server } = this.state;
    if (inFlight === 0) return;
    try {
      const document = await this.api.applyOperations(this.kitId, {
        version: server.version,
        operations: pending.slice(0, inFlight),
      });
      this.dispatch({ type: 'save-succeeded', document });
    } catch (error) {
      if (error instanceof VersionConflictError) {
        this.dispatch({ type: 'save-conflict', current: error.current });
      } else {
        this.dispatch({ type: 'save-failed', failure: failureFor(error) });
      }
    }
  }
}
