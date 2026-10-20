import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuilderOperation } from '@trao/contracts';
import { ApiError } from '../../lib/api/client';
import { addQuestion, edit, fakeServer, networkError } from '../../test/builder';
import { describeOperation } from './describe';
import { BuilderStore, failureFor, type DraftStorage } from './store';

const DEBOUNCE = 800;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function open(server = fakeServer(), drafts?: DraftStorage) {
  const store = new BuilderStore('kit-1', server.api, server.doc, {
    debounceMs: DEBOUNCE,
    ...(drafts ? { drafts } : {}),
  });
  return { store, server };
}
const prompts = (store: BuilderStore) => store.getState().local.kit.questions.map((q) => q.prompt);
/** Lets promise callbacks run without moving the fake clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);
const waitDebounce = () => vi.advanceTimersByTimeAsync(DEBOUNCE);

function memoryDrafts(initial: unknown[] | null = null) {
  const writes: BuilderOperation[][] = [];
  let stored = initial;
  const drafts: DraftStorage = {
    read: () => stored,
    write: (_id, ops) => {
      writes.push(ops);
      stored = ops.length > 0 ? ops : null;
    },
  };
  return {
    drafts,
    writes,
    get stored() {
      return stored;
    },
  };
}

describe('optimistic editing', () => {
  it('shows an edit immediately and sends nothing until the debounce has passed', async () => {
    const { store, server } = open();
    store.edit(edit('q1', 'Typed'));
    expect(prompts(store)[0]).toBe('Typed');
    expect(store.getState().status).toBe('dirty');
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
    expect(server.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.calls).toHaveLength(1);
  });

  it('notifies subscribers of every change and stops after unsubscribe', () => {
    const { store } = open();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.edit(edit('q1', 'A'));
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    store.edit(edit('q1', 'B'));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('debounced autosave', () => {
  it('sends several quick edits as one request, in the order they were made, against the base version', async () => {
    const { store, server } = open();
    store.edit(edit('q1', 'A'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 100);
    store.edit(addQuestion('B'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 100); // the wait restarts with each edit
    expect(server.calls).toHaveLength(0);
    store.edit({ type: 'delete_question', id: 'q2' });
    await waitDebounce();
    expect(server.calls).toEqual([
      {
        version: 1,
        operations: [edit('q1', 'A'), addQuestion('B'), { type: 'delete_question', id: 'q2' }],
      },
    ]);
  });

  it('goes dirty → saving → synced, and adopts the confirmed version and document', async () => {
    const { store, server } = open();
    store.edit(edit('q1', 'A'));
    server.holdNext();
    await waitDebounce();
    expect(store.getState()).toMatchObject({ status: 'saving', inFlight: 1 });
    server.release();
    await settle();
    const s = store.getState();
    expect(s).toMatchObject({ status: 'synced', pending: [], inFlight: 0 });
    expect(s.server.version).toBe(2);
    expect(s.local).toEqual({ kit: server.doc.kit, state: server.doc.builder });
  });

  it('does nothing when there is nothing to save', async () => {
    const { server } = open();
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 5);
    expect(server.calls).toHaveLength(0);
  });

  it('flush saves at once', async () => {
    const { store, server } = open();
    store.edit(edit('q1', 'A'));
    store.flush();
    await settle();
    expect(server.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 3);
    expect(server.calls).toHaveLength(1); // the pending timer was cancelled, no second request
  });

  it('leaving the page still sends unsaved edits', async () => {
    const { store, server } = open();
    store.edit(edit('q1', 'A'));
    store.detach();
    await settle();
    expect(server.calls).toHaveLength(1);
    expect(server.doc.kit.questions[0]?.prompt).toBe('A');
  });
});

describe('edits during a save', () => {
  it('are not sent with it, are visible at once, and go out in the next request on the new version', async () => {
    const { store, server } = open();
    store.edit(edit('q1', 'first'));
    server.holdNext();
    await waitDebounce();
    store.edit(edit('q2', 'second, while saving'));
    store.edit(addQuestion('third, while saving'));
    expect(prompts(store)).toContain('second, while saving');
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.operations).toEqual([edit('q1', 'first')]);

    server.release();
    await settle();
    // the response arrived: the first edit is confirmed, the other two are still pending
    expect(store.getState()).toMatchObject({ status: 'dirty', inFlight: 0 });
    expect(store.getState().pending).toEqual([
      edit('q2', 'second, while saving'),
      addQuestion('third, while saving'),
    ]);
    expect(prompts(store)).toContain('second, while saving');

    await waitDebounce();
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]).toEqual({
      version: 2,
      operations: [edit('q2', 'second, while saving'), addQuestion('third, while saving')],
    });
    expect(store.getState()).toMatchObject({ status: 'synced', pending: [] });
    expect(server.doc.kit.questions.map((q) => q.prompt)).toContain('third, while saving');
    expect(server.doc.kit.questions[0]?.prompt).toBe('first');
  });

  it('never has two requests in flight, however much is typed', async () => {
    const { store, server } = open();
    store.edit(edit('q1', 'a'));
    server.holdNext();
    await waitDebounce();
    for (let i = 0; i < 5; i++) {
      store.edit(edit('q2', `b${i}`));
      await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
    }
    expect(server.calls).toHaveLength(1);
    server.release();
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
    await settle();
    expect(server.maxInFlight).toBe(1);
    expect(server.doc.kit.questions[1]?.prompt).toBe('b4');
  });

  it('keeps edits made during a save that then fails, and sends them with the retry', async () => {
    const { store, server } = open();
    store.edit(edit('q1', 'first'));
    server.holdNext();
    server.failNext(networkError());
    await waitDebounce();
    store.edit(edit('q2', 'during'));
    server.release();
    await settle();
    expect(store.getState().status).toBe('failed');
    expect(store.getState().pending).toHaveLength(2);
    store.retry();
    await settle();
    expect(server.calls.at(-1)).toEqual({
      version: 1,
      operations: [edit('q1', 'first'), edit('q2', 'during')],
    });
    expect(store.getState().status).toBe('synced');
    expect(server.doc.kit.questions[1]?.prompt).toBe('during');
  });
});

describe('failures and retry', () => {
  it('after a network failure keeps the edits, does not retry on its own, and retries when asked, once', async () => {
    const { store, server } = open();
    server.failNext(networkError());
    store.edit(edit('q1', 'A'));
    await waitDebounce();
    expect(store.getState()).toMatchObject({
      status: 'failed',
      failure: { kind: 'network', retryable: true },
    });
    expect(store.getState().pending).toEqual([edit('q1', 'A')]);
    expect(prompts(store)[0]).toBe('A');

    await vi.advanceTimersByTimeAsync(DEBOUNCE * 10);
    expect(server.calls).toHaveLength(1); // no automatic retry loop

    store.retry();
    await settle();
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]).toEqual(server.calls[0]); // the same operations, not a changed or doubled set
    expect(store.getState().status).toBe('synced');
    expect(server.doc.kit.questions.filter((q) => q.prompt === 'A')).toHaveLength(1);
  });

  it('does not duplicate an add when the server applied it but the answer was lost', async () => {
    const { store, server } = open();
    server.failAfterApplyNext(networkError());
    store.edit(addQuestion('only once'));
    await waitDebounce();
    expect(store.getState().status).toBe('failed');
    expect(server.doc.version).toBe(2); // the server did apply it

    store.retry();
    await settle();
    // the retry used version 1, the server answered 409 with its document, and the store recognised it as its own
    expect(store.getState()).toMatchObject({ status: 'synced', pending: [] });
    expect(store.getState().server.version).toBe(2);
    expect(server.doc.kit.questions.filter((q) => q.prompt === 'only once')).toHaveLength(1);
    expect(
      store.getState().local.kit.questions.filter((q) => q.prompt === 'only once'),
    ).toHaveLength(1);
    expect(server.doc.version).toBe(2); // no extra version
  });

  it('does not retry a rejected save, and keeps the edits so the user can decide', async () => {
    const { store, server } = open();
    server.failNext(new ApiError(422, 'OPERATION_REJECTED', 'Question "q9" does not exist'));
    store.edit(edit('q1', 'A'));
    await waitDebounce();
    expect(store.getState()).toMatchObject({
      status: 'failed',
      failure: { kind: 'rejected', retryable: false },
    });
    store.retry();
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 3);
    expect(server.calls).toHaveLength(1);
    expect(store.getState().pending).toHaveLength(1);
    store.discardAll();
    expect(store.getState()).toMatchObject({ status: 'synced', pending: [] });
  });

  it('maps errors to messages that never contain raw error text', () => {
    expect(failureFor(new ApiError(401, 'SESSION_EXPIRED', 'raw'))).toMatchObject({
      kind: 'session',
      retryable: false,
    });
    expect(failureFor(new ApiError(404, 'NOT_FOUND', 'raw'))).toMatchObject({
      kind: 'not-found',
      retryable: false,
    });
    expect(failureFor(new ApiError(0, 'TIMEOUT', 'The server took too long.'))).toMatchObject({
      kind: 'network',
      retryable: true,
    });
    expect(failureFor(new ApiError(429, 'RATE_LIMITED', 'Slow down'))).toMatchObject({
      kind: 'network',
      retryable: true,
    });
    expect(failureFor(new ApiError(500, 'INTERNAL_ERROR', 'secret stack'))).toMatchObject({
      kind: 'server',
      retryable: true,
    });
    expect(failureFor(new ApiError(200, 'BAD_RESPONSE', 'x'))).toMatchObject({
      kind: 'server',
      retryable: true,
    });
    expect(failureFor(new ApiError(400, 'INVALID_OPERATION', 'Bad op'))).toMatchObject({
      kind: 'rejected',
      retryable: false,
    });
    const unexpected = failureFor(new Error('ECONNREFUSED 10.0.0.5'));
    expect(unexpected.message).toBe('Something went wrong while saving.');
    expect(
      JSON.stringify(failureFor(new ApiError(500, 'INTERNAL_ERROR', 'secret stack'))),
    ).not.toMatch(/secret/);
  });
});

describe('conflicts', () => {
  async function conflict() {
    const { store, server } = open();
    server.change('Someone else reworded q2'); // the server is now at version 2
    store.edit(edit('q1', 'mine'));
    store.edit(addQuestion('mine too'));
    await waitDebounce();
    return { store, server };
  }

  it('stops, keeps every pending edit, explains the latest version, and does not resubmit by itself', async () => {
    const { store, server } = await conflict();
    const s = store.getState();
    expect(s.status).toBe('conflict');
    expect(s.conflict?.current.version).toBe(2);
    expect(s.pending).toHaveLength(2);
    expect(prompts(store)).toContain('mine');
    expect(server.doc.kit.questions[0]?.prompt).not.toBe('mine'); // the server document was not overwritten
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 10);
    expect(server.calls).toHaveLength(1);
  });

  it('edits are ignored while the user decides', async () => {
    const { store } = await conflict();
    store.edit(edit('q3', 'late'));
    expect(store.getState().pending).toHaveLength(2);
  });

  it('reapply replays on the current document, and only then do the edits go out, on the new version', async () => {
    const { store, server } = await conflict();
    store.reapply();
    expect(store.getState().status).toBe('dirty');
    expect(store.getState().server.version).toBe(2);
    expect(prompts(store)).toContain('Someone else reworded q2');
    expect(prompts(store)).toContain('mine');
    expect(server.calls).toHaveLength(1); // reapplying is not sending
    await waitDebounce();
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]).toEqual({
      version: 2,
      operations: [edit('q1', 'mine'), addQuestion('mine too')],
    });
    expect(store.getState().status).toBe('synced');
    expect(server.doc.kit.questions.map((q) => q.prompt)).toEqual(
      expect.arrayContaining(['mine', 'mine too', 'Someone else reworded q2']),
    );
  });

  it('a replay that fails names the operation, sends nothing, and drops nothing until the user chooses', async () => {
    const { store, server } = open();
    store.edit(edit('q2', 'fine'));
    store.edit(edit('q1', 'mine'));
    server.apply([{ type: 'delete_question', id: 'q1' }]); // someone else deletes q1
    await waitDebounce();
    expect(store.getState().status).toBe('conflict');

    store.reapply();
    const failed = store.getState();
    expect(failed.status).toBe('conflict');
    expect(failed.conflict?.replayFailure).toMatchObject({ index: 1 });
    expect(failed.conflict?.replayFailure?.message).toMatch(/q1/);
    expect(failed.pending).toHaveLength(2);
    expect(server.calls).toHaveLength(1);

    store.discardFailing();
    expect(store.getState().status).toBe('dirty');
    expect(store.getState().pending).toEqual([edit('q2', 'fine')]);
    await waitDebounce();
    expect(store.getState().status).toBe('synced');
    expect(server.doc.kit.questions.some((q) => q.id === 'q1')).toBe(false); // the other person's deletion stands
    expect(server.doc.kit.questions.find((q) => q.id === 'q2')?.prompt).toBe('fine');
  });

  it('repeated conflicts keep the edits through each round', async () => {
    const { store, server } = await conflict();
    store.reapply();
    server.change('third party', 'q3'); // moves on again before the autosave goes out
    await waitDebounce();
    expect(store.getState().status).toBe('conflict');
    expect(store.getState().conflict?.current.version).toBe(3);
    expect(store.getState().pending).toHaveLength(2);
    store.reapply();
    await waitDebounce();
    expect(store.getState().status).toBe('synced');
    expect(server.doc.version).toBe(4);
    expect(server.doc.kit.questions.map((q) => q.prompt)).toEqual(
      expect.arrayContaining(['mine', 'mine too', 'third party']),
    );
  });

  it('discard-all loads the server version and drops the edits only because the user asked', async () => {
    const { store, server } = await conflict();
    store.discardAll();
    expect(store.getState()).toMatchObject({ status: 'synced', pending: [], conflict: null });
    expect(store.getState().local).toEqual({ kit: server.doc.kit, state: server.doc.builder });
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 5);
    expect(server.calls).toHaveLength(1);
  });
});

describe('drafts kept outside the page', () => {
  it('writes the pending operations on every change and clears them once saved', async () => {
    const mem = memoryDrafts();
    const { store } = open(fakeServer(), mem.drafts);
    store.edit(edit('q1', 'A'));
    expect(mem.stored).toEqual([edit('q1', 'A')]);
    store.edit(edit('q2', 'B'));
    expect(mem.stored).toHaveLength(2);
    await waitDebounce();
    await settle();
    expect(mem.stored).toBeNull();
  });

  it('keeps the draft through a failure', async () => {
    const mem = memoryDrafts();
    const server = fakeServer();
    server.failNext(networkError());
    const { store } = open(server, mem.drafts);
    store.edit(edit('q1', 'A'));
    await waitDebounce();
    expect(store.getState().status).toBe('failed');
    expect(mem.stored).toEqual([edit('q1', 'A')]);
  });

  it('restores an earlier draft as pending edits, which then save normally', async () => {
    const { store, server } = open();
    store.restore([edit('q1', 'from before')]);
    expect(store.getState().status).toBe('dirty');
    expect(prompts(store)[0]).toBe('from before');
    await waitDebounce();
    expect(server.doc.kit.questions[0]?.prompt).toBe('from before');
  });
});

describe('adopting and waiting for a save', () => {
  it('adopt shows a newer server version only when nothing is unsaved, and says whether it did', () => {
    const { store, server } = open();
    server.change('Changed elsewhere');
    expect(store.adopt(server.doc)).toBe(true);
    expect(prompts(store)[1]).toBe('Changed elsewhere');

    server.change('Changed again');
    store.edit(edit('q1', 'unsaved'));
    expect(store.adopt(server.doc)).toBe(false);
    expect(prompts(store)[0]).toBe('unsaved');
  });

  it('whenSynced saves what is pending and resolves true once the server has it', async () => {
    const { store, server } = open();
    store.edit(edit('q1', 'A'));
    const done = store.whenSynced();
    await settle();
    expect(await done).toBe(true);
    expect(server.calls).toHaveLength(1);
    expect(store.getState().status).toBe('synced');
  });

  it('whenSynced resolves true at once when there is nothing to save', async () => {
    const { store, server } = open();
    expect(await store.whenSynced()).toBe(true);
    expect(server.calls).toHaveLength(0);
  });

  it('whenSynced resolves false when saving fails or conflicts, and never starts anything else', async () => {
    const failing = open();
    failing.server.failNext(networkError());
    failing.store.edit(edit('q1', 'A'));
    const failed = failing.store.whenSynced();
    await settle();
    expect(await failed).toBe(false);

    const conflicted = open();
    conflicted.server.change('Changed elsewhere');
    conflicted.store.edit(edit('q1', 'A'));
    const result = conflicted.store.whenSynced();
    await settle();
    expect(await result).toBe(false);
    expect(conflicted.store.getState().status).toBe('conflict');
  });
});

describe('describing operations', () => {
  it('gives each operation one readable line', () => {
    const ops: [BuilderOperation, RegExp][] = [
      [edit('q1', 'x'), /Edit question q1/],
      [
        addQuestion('A very long question that goes on and on and on forever and ever'),
        /^Add question ".{1,41}…?"/,
      ],
      [{ type: 'move_question_to_day', question_id: 'q1', to_day: 2 }, /Move question q1 to day 2/],
      [{ type: 'edit_day_minutes', day: 1, minutes: null }, /calculated minutes for day 1/],
      [{ type: 'edit_day_minutes', day: 1, minutes: 45 }, /day 1 to 45 minutes/],
      [{ type: 'set_pin', target: { kind: 'day', day: 3 }, pinned: true }, /Pin day 3/],
      [
        { type: 'set_pin', target: { kind: 'question', id: 'q2' }, pinned: false },
        /Unpin question q2/,
      ],
      [{ type: 'edit_brief', changes: { summary: 's' } }, /company brief/],
    ];
    for (const [op, pattern] of ops) expect(describeOperation(op)).toMatch(pattern);
  });
});
