import { describe, expect, it } from 'vitest';
import type { BuilderDocumentResponse, BuilderOperation } from '@trao/contracts';
import { applyOperations } from '@trao/core';
import { addQuestion, edit, makeResponse } from '../../test/builder';
import {
  builderReducer,
  initialState,
  toDocument,
  type BuilderAction,
  type BuilderStoreState,
  type SaveFailure,
} from './state';

const run = (actions: BuilderAction[], from: BuilderStoreState = initialState(makeResponse())) =>
  actions.reduce(builderReducer, from);
const doEdit = (operation: BuilderOperation): BuilderAction => ({ type: 'edit', operation });
const q = (s: BuilderStoreState, id: string) => s.local.kit.questions.find((x) => x.id === id);
const ids = (s: BuilderStoreState) => s.local.kit.questions.map((x) => x.id);

/** The server's view after applying operations to a response (what the next response would hold). */
function serverAfter(
  base: BuilderDocumentResponse,
  ops: BuilderOperation[],
): BuilderDocumentResponse {
  const r = applyOperations(toDocument(base), ops);
  if (!r.ok) throw new Error('fixture refused');
  return { ...base, version: base.version + 1, kit: r.document.kit, builder: r.document.state };
}

const network: SaveFailure = { kind: 'network', message: 'down', retryable: true };

describe('local edits', () => {
  it('applies an edit at once, queues it, and marks the state dirty', () => {
    const s = run([doEdit(edit('q1', 'New'))]);
    expect(q(s, 'q1')?.prompt).toBe('New');
    expect(s.pending).toEqual([edit('q1', 'New')]);
    expect(s.status).toBe('dirty');
    expect(s.server.kit.questions[0]?.prompt).not.toBe('New'); // the server copy is untouched
    expect(s.local.state.questions[0]).toMatchObject({ id: 'q1', edited: true });
  });

  it('queues operations in the order they were made', () => {
    const s = run([
      doEdit(edit('q1', 'A')),
      doEdit(addQuestion('B')),
      doEdit({ type: 'delete_question', id: 'q2' }),
    ]);
    expect(s.pending.map((o) => o.type)).toEqual([
      'edit_question',
      'add_question',
      'delete_question',
    ]);
    expect(ids(s)).toEqual(['q1', 'q3', 'q4', 'q5']);
  });

  it('does not queue an edit the builder refuses, and says why', () => {
    const s = run([doEdit({ type: 'delete_question', id: 'nope' })]);
    expect(s.pending).toEqual([]);
    expect(s.status).toBe('synced');
    expect(s.notice).toMatch(/does not exist/);
    expect(run([{ type: 'dismiss-notice' }], s).notice).toBeNull();
  });

  it('a later good edit clears the notice', () => {
    const s = run([doEdit({ type: 'delete_question', id: 'nope' }), doEdit(edit('q1', 'ok'))]);
    expect(s.notice).toBeNull();
    expect(s.pending).toHaveLength(1);
  });

  it('shows coverage gaps straight away after an edit that opens one', () => {
    const s = run([
      doEdit({ type: 'delete_question', id: 'q1' }),
      doEdit({ type: 'delete_question', id: 'q3' }),
    ]);
    expect(s.local.kit.coverage.uncovered_requirement_ids).toEqual(['r1', 'r3', 'r4']);
  });
});

describe('saving', () => {
  it('a save marks how many operations are in flight', () => {
    const s = run([doEdit(edit('q1', 'A')), doEdit(edit('q2', 'B')), { type: 'save-started' }]);
    expect(s).toMatchObject({ status: 'saving', inFlight: 2 });
  });

  it('does not start a second save while one is in flight, nor one with nothing to send', () => {
    const saving = run([doEdit(edit('q1', 'A')), { type: 'save-started' }]);
    expect(builderReducer(saving, { type: 'save-started' })).toBe(saving);
    const idle = initialState(makeResponse());
    expect(builderReducer(idle, { type: 'save-started' })).toBe(idle);
  });

  it('a confirmed save retires its operations, adopts the new base version and becomes synced', () => {
    const base = makeResponse();
    const s0 = run([doEdit(edit('q1', 'A')), { type: 'save-started' }]);
    const confirmed = serverAfter(base, [edit('q1', 'A')]);
    const s = builderReducer(s0, { type: 'save-succeeded', document: confirmed });
    expect(s).toMatchObject({ status: 'synced', pending: [], inFlight: 0, failure: null });
    expect(s.server.version).toBe(2);
    expect(toDocument(s.server)).toEqual(s.local);
  });

  it('edits made while the request is in flight are kept, and replayed on the confirmed document', () => {
    const base = makeResponse();
    const s0 = run([
      doEdit(edit('q1', 'sent')),
      { type: 'save-started' },
      doEdit(edit('q2', 'typed during the save')),
      doEdit(addQuestion('added during the save')),
    ]);
    expect(s0.status).toBe('saving');
    expect(s0.pending).toHaveLength(3);
    expect(q(s0, 'q2')?.prompt).toBe('typed during the save'); // visible immediately

    const confirmed = serverAfter(base, [edit('q1', 'sent')]);
    const s = builderReducer(s0, { type: 'save-succeeded', document: confirmed });
    expect(s.status).toBe('dirty'); // the rest still has to be saved
    expect(s.pending).toEqual([
      edit('q2', 'typed during the save'),
      addQuestion('added during the save'),
    ]);
    expect(s.server.version).toBe(2);
    expect(q(s, 'q1')?.prompt).toBe('sent');
    expect(q(s, 'q2')?.prompt).toBe('typed during the save');
    expect(ids(s)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5']);
  });

  it('ignores a response nobody is waiting for', () => {
    const s0 = run([doEdit(edit('q1', 'A'))]);
    const late = serverAfter(makeResponse(), [edit('q1', 'A')]);
    expect(builderReducer(s0, { type: 'save-succeeded', document: late })).toBe(s0);
    expect(builderReducer(s0, { type: 'save-conflict', current: late })).toBe(s0);
  });
});

describe('failures', () => {
  it('keeps every pending operation after a failed save, and shows the failure', () => {
    const s = run([
      doEdit(edit('q1', 'A')),
      doEdit(edit('q2', 'B')),
      { type: 'save-started' },
      { type: 'save-failed', failure: network },
    ]);
    expect(s).toMatchObject({ status: 'failed', inFlight: 0, failure: network });
    expect(s.pending).toHaveLength(2);
    expect(q(s, 'q1')?.prompt).toBe('A');
  });

  it('edits made after a failure join the queue, and one retry sends all of it', () => {
    const failed = run([
      doEdit(edit('q1', 'A')),
      { type: 'save-started' },
      { type: 'save-failed', failure: network },
      doEdit(edit('q2', 'B')),
    ]);
    expect(failed.status).toBe('failed');
    const retried = builderReducer(failed, { type: 'retry' });
    expect(retried.status).toBe('dirty');
    const started = builderReducer(retried, { type: 'save-started' });
    expect(started.inFlight).toBe(2);
  });

  it('a failure that retrying cannot fix is not retried', () => {
    const rejected: SaveFailure = { kind: 'rejected', message: 'no', retryable: false };
    const s = run([
      doEdit(edit('q1', 'A')),
      { type: 'save-started' },
      { type: 'save-failed', failure: rejected },
    ]);
    expect(builderReducer(s, { type: 'retry' })).toBe(s);
  });

  it('discarding after a failure returns to the server document and loses nothing but the pending edits', () => {
    const s = run([
      doEdit(edit('q1', 'A')),
      { type: 'save-started' },
      { type: 'save-failed', failure: network },
      { type: 'discard-all' },
    ]);
    expect(s).toMatchObject({ status: 'synced', pending: [], failure: null });
    expect(q(s, 'q1')?.prompt).toBe(makeResponse().kit.questions[0]!.prompt);
  });
});

describe('conflicts', () => {
  const base = makeResponse();
  /** The kit moved on to version 2 elsewhere (q2 was reworded). */
  const current = serverAfter(base, [edit('q2', 'Someone else reworded this')]);

  const conflicted = () =>
    run([
      doEdit(edit('q1', 'mine')),
      doEdit(addQuestion('mine too')),
      { type: 'save-started' },
      { type: 'save-conflict', current },
    ]);

  it('preserves the pending edits and the local view, records the latest server version, and applies nothing', () => {
    const s = conflicted();
    expect(s.status).toBe('conflict');
    expect(s.conflict?.current.version).toBe(2);
    expect(s.conflict?.replayFailure).toBeNull();
    expect(s.pending).toHaveLength(2);
    expect(s.inFlight).toBe(0);
    expect(q(s, 'q1')?.prompt).toBe('mine');
    expect(s.server.version).toBe(1); // not adopted until the user chooses
  });

  it('blocks further edits until the user decides', () => {
    const s = conflicted();
    expect(builderReducer(s, doEdit(edit('q2', 'more')))).toBe(s);
  });

  it('never resubmits by itself: save-started does nothing in a conflict', () => {
    const s = conflicted();
    expect(builderReducer(s, { type: 'save-started' })).toBe(s);
  });

  it("reapply puts the pending edits on the current server document, keeping their order and the other person's change", () => {
    const s = builderReducer(conflicted(), { type: 'reapply' });
    expect(s.status).toBe('dirty');
    expect(s.conflict).toBeNull();
    expect(s.server.version).toBe(2);
    expect(q(s, 'q1')?.prompt).toBe('mine');
    expect(q(s, 'q2')?.prompt).toBe('Someone else reworded this');
    expect(ids(s)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5']);
    expect(s.pending).toHaveLength(2);
  });

  it('reapply that fails names the operation, keeps everything, and applies none of it', () => {
    const removed = serverAfter(base, [{ type: 'delete_question', id: 'q1' }]); // someone deleted q1
    const s0 = run([
      doEdit(edit('q2', 'fine')),
      doEdit(edit('q1', 'mine')),
      { type: 'save-started' },
      { type: 'save-conflict', current: removed },
    ]);
    const s = builderReducer(s0, { type: 'reapply' });
    expect(s.status).toBe('conflict');
    expect(s.conflict?.replayFailure).toMatchObject({ index: 1 });
    expect(s.conflict?.replayFailure?.message).toMatch(/q1/);
    expect(s.pending).toHaveLength(2); // nothing dropped
    expect(s.server.version).toBe(1);
    expect(q(s, 'q1')?.prompt).toBe('mine'); // the local view still shows the user's work
  });

  it('discard-failing drops only that operation and replays the rest', () => {
    const removed = serverAfter(base, [{ type: 'delete_question', id: 'q1' }]);
    const s0 = run([
      doEdit(edit('q2', 'fine')),
      doEdit(edit('q1', 'mine')),
      { type: 'save-started' },
      { type: 'save-conflict', current: removed },
    ]);
    const failed = builderReducer(s0, { type: 'reapply' });
    const s = builderReducer(failed, { type: 'discard-failing' });
    expect(s.status).toBe('dirty');
    expect(s.pending).toEqual([edit('q2', 'fine')]);
    expect(q(s, 'q2')?.prompt).toBe('fine');
    expect(s.local.kit.questions.some((x) => x.id === 'q1')).toBe(false); // the server's deletion stands
  });

  it('discard-failing can leave nothing to save', () => {
    const removed = serverAfter(base, [{ type: 'delete_question', id: 'q1' }]);
    const s0 = run([
      doEdit(edit('q1', 'mine')),
      { type: 'save-started' },
      { type: 'save-conflict', current: removed },
    ]);
    const s = run([{ type: 'reapply' }, { type: 'discard-failing' }], s0);
    expect(s).toMatchObject({ status: 'synced', pending: [] });
  });

  it('discard-all adopts the server document and drops the edits, only on request', () => {
    const s = builderReducer(conflicted(), { type: 'discard-all' });
    expect(s).toMatchObject({ status: 'synced', pending: [], conflict: null });
    expect(s.server.version).toBe(2);
    expect(q(s, 'q1')?.prompt).toBe(base.kit.questions[0]!.prompt);
    expect(q(s, 'q2')?.prompt).toBe('Someone else reworded this');
  });

  it('a second conflict after a reapply is handled the same way, with the edits still intact', () => {
    const afterFirst = run([{ type: 'reapply' }, { type: 'save-started' }], conflicted());
    expect(afterFirst.inFlight).toBe(2);
    const newer = serverAfter(current, [edit('q3', 'third party')]);
    const s = builderReducer(afterFirst, { type: 'save-conflict', current: newer });
    expect(s.status).toBe('conflict');
    expect(s.conflict?.current.version).toBe(3);
    expect(s.pending).toHaveLength(2);
    const again = builderReducer(s, { type: 'reapply' });
    expect(again.status).toBe('dirty');
    expect(q(again, 'q3')?.prompt).toBe('third party');
    expect(q(again, 'q1')?.prompt).toBe('mine');
  });

  it('recognises a save whose answer was lost: the server already holds exactly these edits, so nothing is applied twice', () => {
    const s0 = run([doEdit(addQuestion('only once')), { type: 'save-started' }]);
    const appliedByServer = serverAfter(base, [addQuestion('only once')]);
    const s = builderReducer(s0, { type: 'save-conflict', current: appliedByServer });
    expect(s).toMatchObject({ status: 'synced', pending: [] });
    expect(s.local.kit.questions.filter((x) => x.prompt === 'only once')).toHaveLength(1);
    expect(s.server.version).toBe(2);
  });

  it("does not mistake someone else's identical-looking change for its own save", () => {
    const s0 = run([doEdit(edit('q1', 'mine')), { type: 'save-started' }]);
    const different = serverAfter(base, [edit('q1', 'theirs')]);
    expect(builderReducer(s0, { type: 'save-conflict', current: different }).status).toBe(
      'conflict',
    );
  });
});

describe('restoring unsaved edits from an earlier visit', () => {
  it('replays them all-or-nothing on the loaded document and makes them pending', () => {
    const s = run([{ type: 'restore', operations: [edit('q1', 'draft'), addQuestion('draft q')] }]);
    expect(s.status).toBe('dirty');
    expect(s.pending).toHaveLength(2);
    expect(q(s, 'q1')?.prompt).toBe('draft');
  });

  it('refuses a draft that no longer applies and says so, changing nothing', () => {
    const s = run([
      { type: 'restore', operations: [edit('q1', 'ok'), { type: 'delete_question', id: 'gone' }] },
    ]);
    expect(s.status).toBe('synced');
    expect(s.pending).toEqual([]);
    expect(s.notice).toMatch(/could not be restored/);
    expect(q(s, 'q1')?.prompt).toBe(makeResponse().kit.questions[0]!.prompt);
  });

  it('does nothing once the user has already started editing', () => {
    const edited = run([doEdit(edit('q1', 'now'))]);
    expect(builderReducer(edited, { type: 'restore', operations: [edit('q2', 'old')] })).toBe(
      edited,
    );
  });
});

describe('adopting a newer server version', () => {
  const base = makeResponse();
  const newer = serverAfter(base, [edit('q2', 'Regenerated on the server')]);

  it('replaces the document when nothing unsaved could be lost', () => {
    const s = run([{ type: 'adopt', document: newer }]);
    expect(s).toMatchObject({ status: 'synced', pending: [] });
    expect(s.server.version).toBe(2);
    expect(q(s, 'q2')?.prompt).toBe('Regenerated on the server');
    expect(s.local).toEqual(toDocument(newer));
  });

  it('refuses while there are unsaved edits, in flight edits, a failure or a conflict, changing nothing', () => {
    const dirty = run([doEdit(edit('q1', 'mine'))]);
    expect(builderReducer(dirty, { type: 'adopt', document: newer })).toBe(dirty);
    const saving = builderReducer(dirty, { type: 'save-started' });
    expect(builderReducer(saving, { type: 'adopt', document: newer })).toBe(saving);
    const failed = builderReducer(saving, { type: 'save-failed', failure: network });
    expect(builderReducer(failed, { type: 'adopt', document: newer })).toBe(failed);
    const conflicted = builderReducer(saving, { type: 'save-conflict', current: newer });
    expect(builderReducer(conflicted, { type: 'adopt', document: newer })).toBe(conflicted);
    expect(q(dirty, 'q1')?.prompt).toBe('mine'); // the unsaved edit is still shown
  });

  it('ignores a version that is not newer', () => {
    const s = initialState(newer);
    expect(builderReducer(s, { type: 'adopt', document: base })).toBe(s);
    expect(builderReducer(s, { type: 'adopt', document: newer })).toBe(s);
  });
});
