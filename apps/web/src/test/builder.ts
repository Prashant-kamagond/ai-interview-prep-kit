import type { BuilderDocumentResponse, BuilderOperation, Kit } from '@trao/contracts';
import { applyOperations, createBuilderDocument } from '@trao/core';
import { ApiError } from '../lib/api/client';
import { VersionConflictError, type SaveRequest } from '../lib/api/builder';
import { makeKit } from './kit';

/** The viewer fixture with its days in order (the builder, like the server, requires day 1..N in order). */
export function builderKit(): Kit {
  const kit = makeKit();
  return {
    ...kit,
    schedule: { ...kit.schedule, days: [...kit.schedule.days].sort((a, b) => a.day - b.day) },
  };
}

export function makeResponse(
  kit: Kit = builderKit(),
  over: Partial<BuilderDocumentResponse> = {},
): BuilderDocumentResponse {
  const started = createBuilderDocument(kit);
  if (!started.ok) throw new Error(`fixture kit invalid: ${JSON.stringify(started.error)}`);
  return {
    id: 'a'.repeat(24),
    version: 1,
    kit: started.document.kit,
    builder: started.document.state,
    research: { status: 'unavailable', reason: 'not_persisted' },
    created_at: '2026-03-01T10:00:00.000Z',
    updated_at: '2026-03-01T10:00:00.000Z',
    ...over,
  };
}

export const edit = (id: string, prompt: string): BuilderOperation => ({
  type: 'edit_question',
  id,
  changes: { prompt },
});

export const addQuestion = (prompt: string): BuilderOperation => ({
  type: 'add_question',
  question: {
    prompt,
    answer_outline: '',
    difficulty: 1,
    category: 'technical',
    requirement_ids: [],
  },
});

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A small stand-in for the server that applies operations with the real pure builder, checks the
 * base version like the real endpoint, and lets a test hold a request open or make it fail.
 */
export function fakeServer(initial: BuilderDocumentResponse = makeResponse()) {
  let doc = initial;
  const calls: SaveRequest[] = [];
  let hold: ReturnType<typeof deferred> | null = null;
  let failBefore: unknown = null;
  let failAfter: unknown = null;
  let inFlight = 0;
  let maxInFlight = 0;

  const server = {
    calls,
    get doc() {
      return doc;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    /** Someone else changes the kit: the version moves on. */
    change(prompt: string, id = 'q2') {
      const r = applyOperations({ kit: doc.kit, state: doc.builder }, [edit(id, prompt)]);
      if (!r.ok) throw new Error('fixture change refused');
      doc = { ...doc, version: doc.version + 1, kit: r.document.kit, builder: r.document.state };
    },
    /** Someone else applies operations: the version moves on. */
    apply(operations: BuilderOperation[]) {
      const r = applyOperations({ kit: doc.kit, state: doc.builder }, operations);
      if (!r.ok) throw new Error(`fixture change refused: ${r.error.message}`);
      doc = { ...doc, version: doc.version + 1, kit: r.document.kit, builder: r.document.state };
    },
    /** The next request waits until `release()`. */
    holdNext() {
      hold = deferred();
    },
    release() {
      hold?.resolve(undefined);
      hold = null;
    },
    /** The next request fails before the server does anything. */
    failNext(error: unknown) {
      failBefore = error;
    },
    /** The next request is applied by the server, but the client never hears back. */
    failAfterApplyNext(error: unknown) {
      failAfter = error;
    },
    api: {
      async applyOperations(_id: string, request: SaveRequest): Promise<BuilderDocumentResponse> {
        calls.push(JSON.parse(JSON.stringify(request)) as SaveRequest);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await hold?.promise;
          if (failBefore) {
            const error = failBefore;
            failBefore = null;
            throw error;
          }
          if (request.version !== doc.version) {
            throw new VersionConflictError('The kit was changed since you loaded it.', doc);
          }
          const result = applyOperations({ kit: doc.kit, state: doc.builder }, request.operations);
          if (!result.ok) throw new ApiError(422, 'OPERATION_REJECTED', result.error.message);
          doc = {
            ...doc,
            version: doc.version + 1,
            kit: result.document.kit,
            builder: result.document.state,
          };
          if (failAfter) {
            const error = failAfter;
            failAfter = null;
            throw error;
          }
          return doc;
        } finally {
          inFlight -= 1;
        }
      },
    },
  };
  return server;
}

export const networkError = () =>
  new ApiError(
    0,
    'NETWORK_ERROR',
    'Could not reach the server. Check your connection and try again.',
  );
