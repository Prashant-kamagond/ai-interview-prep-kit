import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  builderDocumentResponseSchema,
  type BuilderDocumentResponse,
  type Kit,
  type ResearchSnapshot,
} from '@trao/contracts';
import { checkBuilderDocument } from '@trao/core';
import { makeKit, question } from '@trao/core/testing';
import { client, createHarness, signUp, type Harness, type TestClient } from './test/harness.js';

const AVAILABLE_RESEARCH: ResearchSnapshot = {
  status: 'available',
  captured_at: '2026-09-01T09:12:44Z',
  company_url: 'http://localhost:8099/acme/',
  company_name: 'Acme',
  crawl_status: 'ok',
  pages: [
    {
      url: 'http://localhost:8099/acme/careers',
      title: 'Careers',
      description: '',
      role: 'hiring',
      depth: 1,
      text: 'We interview in three rounds.',
      interview_mentions: ['We interview in three rounds.'],
      fetched_at: '2026-09-01T09:12:44Z',
    },
  ],
  discussion: {
    provider: 'hn-algolia',
    status: 'ok',
    retrieved_at: '2026-09-01T09:12:44Z',
    items: [
      {
        url: 'https://news.ycombinator.com/item?id=1',
        kind: 'comment',
        title: null,
        snippet: 'Acme asks system design.',
      },
    ],
  },
};

describe('builder endpoints', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const kitsCollection = () => h.db.collection('kits');
  const rawDoc = async (id: string) => kitsCollection().findOne({ _id: new ObjectId(id) });

  async function userId(c: TestClient): Promise<ObjectId> {
    return new ObjectId((await c.get('/auth/me')).body.user.id as string);
  }
  /** A kit as saved before the builder existed: no builder state, no research. */
  async function legacyKit(c: TestClient, kit: Kit = makeKit()): Promise<string> {
    const doc = await h.repos.kits.insert(await userId(c), kit);
    return doc._id.toHexString();
  }
  async function newKit(c: TestClient, kit: Kit = makeKit()): Promise<string> {
    const res = await c.post('/kits', { kit });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }
  const ops = (c: TestClient, id: string, version: number, operations: unknown[]) =>
    c.post(`/kits/${id}/operations`, { version, operations });
  const edit = (prompt: string, qid = 'q1') => ({
    type: 'edit_question',
    id: qid,
    changes: { prompt },
  });

  describe('authentication and ownership', () => {
    it('requires a signed-in user on both endpoints', async () => {
      const anon = client(h.app);
      const id = '0'.repeat(24);
      expect((await anon.get(`/kits/${id}/builder`)).status).toBe(401);
      expect((await ops(anon, id, 1, [edit('x')])).status).toBe(401);
    });

    it("never exposes or changes another user's builder state, answering 404 as if it did not exist", async () => {
      const alice = await signUp(h.app);
      const bob = await signUp(h.app);
      const id = await newKit(alice);
      const before = await rawDoc(id);

      expect((await bob.get(`/kits/${id}/builder`)).status).toBe(404);
      const attempt = await ops(bob, id, 1, [edit('Bob was here')]);
      expect(attempt.status).toBe(404);
      expect(JSON.stringify(attempt.body)).not.toMatch(/Acme|conflict/i);
      expect(await rawDoc(id)).toEqual(before);
      // the owner still sees her own data
      expect((await alice.get(`/kits/${id}/builder`)).status).toBe(200);
    });

    it('treats a missing kit and a malformed id the same way', async () => {
      const c = await signUp(h.app);
      for (const id of [new ObjectId().toHexString(), 'not-an-id', '..%2F..%2Fkits']) {
        expect((await c.get(`/kits/${id}/builder`)).status).toBe(404);
        expect((await ops(c, id, 1, [edit('x')])).status).toBe(404);
      }
    });

    it('does not create builder state for a kit that is not yours', async () => {
      const alice = await signUp(h.app);
      const bob = await signUp(h.app);
      const id = await legacyKit(alice);
      expect((await bob.get(`/kits/${id}/builder`)).status).toBe(404);
      expect((await rawDoc(id))?.builder).toBeUndefined();
    });
  });

  describe('reading', () => {
    it('returns the kit, its state, the version and an explicit "unavailable" research snapshot', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const res = await c.get(`/kits/${id}/builder`);
      expect(res.status).toBe(200);
      const body = builderDocumentResponseSchema.parse(res.body);
      expect(body).toMatchObject({ id, version: 1, kit: makeKit() });
      expect(body.builder.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
      expect(
        body.builder.questions.every((q) => q.origin === 'generated' && !q.edited && !q.pinned),
      ).toBe(true);
      expect(body.builder.next_ids).toEqual({ question: 3, flashcard: 2, requirement: 3 });
      expect(body.research).toEqual({ status: 'unavailable', reason: 'not_persisted' });
      expect(res.body.userId).toBeUndefined();
      expect(checkBuilderDocument({ kit: body.kit, state: body.builder }).ok).toBe(true);
    });

    it('a kit created through POST /kits stores its builder state in the same insert', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const raw = await rawDoc(id);
      expect(raw?.builder).toBeDefined();
      expect(raw?.research).toBeUndefined(); // nothing is invented
    });

    it('initialises state for a legacy kit once, without changing the kit or its version', async () => {
      const c = await signUp(h.app);
      const id = await legacyKit(c);
      const before = await rawDoc(id);
      expect(before?.builder).toBeUndefined();

      const first = await c.get(`/kits/${id}/builder`);
      expect(first.status).toBe(200);
      const after = await rawDoc(id);
      expect(after?.builder).toEqual(first.body.builder);
      expect(after?.kit).toEqual(before?.kit);
      expect(after?.version).toBe(1);
      expect(after?.updatedAt).toEqual(before?.updatedAt);
      expect(first.body.version).toBe(1);

      const second = await c.get(`/kits/${id}/builder`);
      expect(second.body).toEqual(first.body);
    });

    it('concurrent first reads of a legacy kit all succeed and agree on one stored state', async () => {
      const c = await signUp(h.app);
      const id = await legacyKit(c);
      const results = await Promise.all(
        Array.from({ length: 12 }, () => c.get(`/kits/${id}/builder`)),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      const states = new Set(results.map((r) => JSON.stringify(r.body.builder)));
      expect(states.size).toBe(1);
      const raw = await rawDoc(id);
      expect(JSON.stringify(raw?.builder)).toBe([...states][0]);
      expect(raw?.version).toBe(1);
    });

    it('a legacy kit can be edited straight away, and the edit is applied to the initialised state', async () => {
      const c = await signUp(h.app);
      const id = await legacyKit(c);
      const res = await ops(c, id, 1, [edit('Edited legacy')]);
      expect(res.status).toBe(200);
      expect(res.body.version).toBe(2);
      expect(res.body.builder.questions[0]).toMatchObject({ id: 'q1', edited: true });
    });

    it('answers 500 with a generic message, and changes nothing, when the stored state is unusable', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      await kitsCollection().updateOne(
        { _id: new ObjectId(id) },
        { $set: { 'builder.next_ids.question': 1 } },
      );
      const before = await rawDoc(id);
      for (const res of [await c.get(`/kits/${id}/builder`), await ops(c, id, 1, [edit('x')])]) {
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe('BUILDER_STATE_CORRUPT');
        expect(JSON.stringify(res.body)).not.toMatch(/counter|q1|next_ids/);
      }
      expect(await rawDoc(id)).toEqual(before); // never silently repaired
    });
  });

  describe('research snapshots', () => {
    it('returns a stored snapshot, and keeps it through operations and whole-kit saves', async () => {
      const c = await signUp(h.app);
      const doc = await h.repos.kits.insert(await userId(c), makeKit(), {
        research: AVAILABLE_RESEARCH,
      });
      const id = doc._id.toHexString();
      const read = await c.get(`/kits/${id}/builder`);
      expect(read.body.research).toEqual(AVAILABLE_RESEARCH);

      const done = await ops(c, id, 1, [edit('Changed')]);
      expect(done.body.research).toEqual(AVAILABLE_RESEARCH);
      const kit = makeKit();
      kit.questions[1]!.prompt = 'Whole kit edit';
      expect((await c.put(`/kits/${id}`, { version: 2, kit })).status).toBe(200);
      expect((await c.get(`/kits/${id}/builder`)).body.research).toEqual(AVAILABLE_RESEARCH);
      expect((await rawDoc(id))?.research).toEqual(AVAILABLE_RESEARCH);
    });

    it('says "invalid_stored_data" rather than showing or hiding a damaged snapshot', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      await kitsCollection().updateOne(
        { _id: new ObjectId(id) },
        { $set: { research: { status: 'available', pages: 'nope' } } },
      );
      const res = await c.get(`/kits/${id}/builder`);
      expect(res.status).toBe(200);
      expect(res.body.research).toEqual({ status: 'unavailable', reason: 'invalid_stored_data' });
    });
  });

  describe('operations', () => {
    it('applies a valid batch in order and stores kit, state and version together', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const res = await ops(c, id, 1, [
        edit('Rewritten'),
        { type: 'set_pin', target: { kind: 'question', id: 'q2' }, pinned: true },
        {
          type: 'add_question',
          question: {
            prompt: 'Mine',
            answer_outline: '',
            difficulty: 1,
            category: 'company-fit',
            requirement_ids: ['r2'],
          },
        },
        { type: 'delete_flashcard', id: 'f1' },
      ]);
      expect(res.status).toBe(200);
      const body = builderDocumentResponseSchema.parse(res.body);
      expect(body.version).toBe(2);
      expect(body.kit.questions.map((q) => [q.id, q.prompt])).toEqual([
        ['q1', 'Rewritten'],
        ['q2', 'Prompt q2'],
        ['q3', 'Mine'],
      ]);
      expect(body.builder.questions.map((q) => [q.id, q.origin, q.edited, q.pinned])).toEqual([
        ['q1', 'generated', true, false],
        ['q2', 'generated', false, true],
        ['q3', 'manual', false, false],
      ]);
      expect(body.builder.tombstones).toEqual([{ kind: 'flashcard', id: 'f1', match_key: 'f' }]);

      const raw = await rawDoc(id);
      expect(raw?.version).toBe(2);
      expect(raw?.kit).toEqual(body.kit);
      expect(raw?.builder).toEqual(body.builder);
      expect((await c.get(`/kits/${id}/builder`)).body).toEqual(res.body);
      // the plain kit endpoint shows the same kit and version
      const plain = await c.get(`/kits/${id}`);
      expect(plain.body.kit).toEqual(body.kit);
      expect(plain.body.version).toBe(2);
    });

    it('rejects an invalid batch as a whole, naming the operation, and stores nothing', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const before = await rawDoc(id);
      const res = await ops(c, id, 1, [
        edit('Would be applied'),
        { type: 'delete_question', id: 'q99' },
        edit('Also', 'q2'),
      ]);
      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({
        code: 'OPERATION_REJECTED',
        details: { reason: 'NOT_FOUND', operation_index: 1 },
      });
      expect(await rawDoc(id)).toEqual(before);
      expect((await c.get(`/kits/${id}`)).body.kit.questions[0].prompt).toBe('Prompt q1');
    });

    it.each([
      ['an unknown operation', [{ type: 'explode' }], 0],
      [
        'a malformed operation after a good one',
        [edit('ok'), { type: 'edit_question', id: 'q1', changes: {} }],
        1,
      ],
      ['a request to add a schedule day', [{ type: 'add_day' }], 0],
    ])(
      'answers 400 INVALID_OPERATION for %s and stores nothing',
      async (_name, operations, index) => {
        const c = await signUp(h.app);
        const id = await newKit(c);
        const before = await rawDoc(id);
        const res = await ops(c, id, 1, operations);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatchObject({
          code: 'INVALID_OPERATION',
          details: { operation_index: index },
        });
        expect(res.body.error.request_id).toEqual(expect.any(String));
        expect(await rawDoc(id)).toEqual(before);
      },
    );

    it.each([
      ['no body', undefined],
      ['no version', { operations: [edit('x')] }],
      ['a zero version', { version: 0, operations: [edit('x')] }],
      ['no operations', { version: 1, operations: [] }],
      [
        'too many operations',
        { version: 1, operations: Array.from({ length: 101 }, () => edit('x')) },
      ],
      ['operations that are not a list', { version: 1, operations: edit('x') }],
    ])('answers 400 VALIDATION_ERROR for %s', async (_name, body) => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const res = await c.post(`/kits/${id}/operations`, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect((await rawDoc(id))?.version).toBe(1);
    });

    it('leaves an honest coverage gap when the only question for a must-have is deleted', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const res = await ops(c, id, 1, [{ type: 'delete_question', id: 'q1' }]);
      expect(res.status).toBe(200);
      expect(res.body.kit.coverage.uncovered_requirement_ids).toEqual(['r1']);
      expect(res.body.builder.tombstones).toHaveLength(1);
    });

    it('does not create a new version when the operations change nothing', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const before = await rawDoc(id);
      const res = await ops(c, id, 1, [
        { type: 'set_pin', target: { kind: 'question', id: 'q1' }, pinned: false },
      ]);
      expect(res.status).toBe(200);
      expect(res.body.version).toBe(1);
      expect(await rawDoc(id)).toEqual(before);
    });

    it('never reuses a deleted id across separate requests', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const add = {
        type: 'add_question',
        question: {
          prompt: 'New',
          answer_outline: '',
          difficulty: 1,
          category: 'technical',
          requirement_ids: [],
        },
      };
      expect(
        (await ops(c, id, 1, [add])).body.kit.questions.map((q: { id: string }) => q.id),
      ).toEqual(['q1', 'q2', 'q3']);
      await ops(c, id, 2, [{ type: 'delete_question', id: 'q3' }]);
      const res = await ops(c, id, 3, [add]);
      expect(res.body.kit.questions.map((q: { id: string }) => q.id)).toEqual(['q1', 'q2', 'q4']);
    });
  });

  describe('version conflicts', () => {
    it('answers 409 with the current document, applies nothing, and never replays the operations', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      expect((await ops(c, id, 1, [edit('Newer edit')])).status).toBe(200);
      const before = await rawDoc(id);

      const stale = await ops(c, id, 1, [edit('Stale edit', 'q2')]);
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('VERSION_CONFLICT');
      expect(stale.body.error.details.current_version).toBe(2);
      const current = builderDocumentResponseSchema.parse(stale.body.error.details.current);
      expect(current.version).toBe(2);
      expect(current.kit.questions[0]?.prompt).toBe('Newer edit');
      expect(current.kit.questions[1]?.prompt).toBe('Prompt q2'); // the stale edit was NOT applied
      expect(await rawDoc(id)).toEqual(before);
      expect(current).toEqual((await c.get(`/kits/${id}/builder`)).body);

      // explicit recovery: re-apply against the version the conflict reported
      const retry = await ops(c, id, current.version, [edit('Stale edit', 'q2')]);
      expect(retry.status).toBe(200);
      expect(retry.body.version).toBe(3);
    });

    it('lets exactly one of several concurrent batches from the same version win, and stays consistent', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          ops(c, id, 1, [
            edit(`writer ${i}`),
            { type: 'set_pin', target: { kind: 'question', id: 'q1' }, pinned: true },
          ]),
        ),
      );
      const wins = results.filter((r) => r.status === 200);
      const losses = results.filter((r) => r.status === 409);
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(9);

      const winner = wins[0]!.body as BuilderDocumentResponse;
      const raw = await rawDoc(id);
      expect(raw?.version).toBe(2);
      expect(raw?.kit).toEqual(winner.kit);
      expect(raw?.builder).toEqual(winner.builder);
      expect(winner.kit.questions[0]?.prompt).toMatch(/^writer \d$/);
      expect(checkBuilderDocument({ kit: winner.kit, state: winner.builder }).ok).toBe(true);
      // every loser was handed that same winning document
      for (const l of losses) expect(l.body.error.details.current).toEqual(winner);
    });

    it('does not answer 409 for a kit that is not yours', async () => {
      const alice = await signUp(h.app);
      const bob = await signUp(h.app);
      const id = await newKit(alice);
      expect((await ops(bob, id, 99, [edit('x')])).status).toBe(404);
    });
  });

  describe('persistence failures', () => {
    it('leaves kit, state and version exactly as they were if the write fails', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const before = await rawDoc(id);
      const original = h.repos.kits.replaceDocumentIfVersion;
      h.repos.kits.replaceDocumentIfVersion = async () => {
        throw new Error('connect ECONNREFUSED mongodb://admin:hunter2@internal-host');
      };
      try {
        const res = await ops(c, id, 1, [edit('Lost')]);
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe('INTERNAL_ERROR');
        expect(JSON.stringify(res.body)).not.toMatch(/hunter2|internal-host|ECONNREFUSED/);
        const put = makeKit();
        put.questions[0]!.prompt = 'Lost too';
        expect((await c.put(`/kits/${id}`, { version: 1, kit: put })).status).toBe(500);
      } finally {
        h.repos.kits.replaceDocumentIfVersion = original;
      }
      expect(await rawDoc(id)).toEqual(before);
      expect((await ops(c, id, 1, [edit('Now it works')])).status).toBe(200);
    });
  });

  describe('whole-kit PUT keeps working and keeps the builder state', () => {
    const wholeKit = async (c: TestClient, id: string) =>
      (await c.get(`/kits/${id}`)).body.kit as Kit;

    it('still replaces the kit and answers in the original shape (legacy kit included)', async () => {
      const c = await signUp(h.app);
      const id = await legacyKit(c);
      const edited = makeKit();
      edited.questions[0]!.prompt = 'Edited by PUT';
      const res = await c.put(`/kits/${id}`, { version: 1, kit: edited });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id, version: 2, kit: edited });
      expect(res.body.builder).toBeUndefined(); // the original response is unchanged
    });

    it('gives a legacy kit a state on its first whole-kit save, marking what the save changed as edited', async () => {
      const c = await signUp(h.app);
      const id = await legacyKit(c);
      const edited = makeKit();
      edited.questions[0]!.prompt = 'Edited by PUT';
      await c.put(`/kits/${id}`, { version: 1, kit: edited });
      const raw = await rawDoc(id);
      expect(
        raw?.builder.questions.map((q: { id: string; edited: boolean }) => [q.id, q.edited]),
      ).toEqual([
        ['q1', true],
        ['q2', false],
      ]);
      expect(raw?.builder.tombstones).toEqual([]);
    });

    it('preserves provenance, pins, tombstones and counters through a whole-kit save', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const built = await ops(c, id, 1, [
        { type: 'set_pin', target: { kind: 'question', id: 'q1' }, pinned: true },
        { type: 'delete_question', id: 'q2' },
        {
          type: 'add_question',
          question: {
            prompt: 'Manual one',
            answer_outline: '',
            difficulty: 2,
            category: 'technical',
            requirement_ids: ['r2'],
          },
        },
        { type: 'set_pin', target: { kind: 'brief' }, pinned: true },
      ]);
      expect(built.status).toBe(200);

      const kit = await wholeKit(c, id);
      kit.questions[0]!.prompt = 'Changed through PUT';
      const res = await c.put(`/kits/${id}`, { version: 2, kit });
      expect(res.status).toBe(200);

      const state = (await c.get(`/kits/${id}/builder`)).body.builder;
      expect(state.questions).toEqual([
        { id: 'q1', origin: 'generated', edited: true, pinned: true },
        { id: 'q3', origin: 'manual', edited: false, pinned: false },
      ]);
      expect(state.tombstones).toEqual([{ kind: 'question', id: 'q2', match_key: 'prompt q2' }]);
      expect(state.next_ids.question).toBe(4);
      expect(state.brief).toEqual({ edited: false, pinned: true });
    });

    it('records a question removed by a whole-kit save as deleted (generated) or just gone (manual), and never lowers a counter', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      await ops(c, id, 1, [
        {
          type: 'add_question',
          question: {
            prompt: 'Manual',
            answer_outline: '',
            difficulty: 1,
            category: 'technical',
            requirement_ids: [],
          },
        },
      ]);
      const kit = await wholeKit(c, id);
      kit.questions = kit.questions.filter((q) => q.id === 'q1'); // drops generated q2 and manual q3
      kit.schedule.days.forEach((d) => (d.question_ids = d.question_ids.filter((x) => x === 'q1')));
      kit.coverage.uncovered_requirement_ids = ['r2'];
      kit.schedule.days[0]!.minutes = 20;
      const res = await c.put(`/kits/${id}`, { version: 2, kit });
      expect(res.status).toBe(200);

      const state = (await c.get(`/kits/${id}/builder`)).body.builder;
      expect(state.tombstones.map((t: { id: string }) => t.id)).toEqual(['q2']); // q3 was manual: no tombstone
      expect(state.next_ids.question).toBe(4); // q3 was handed out once, so 3 is never given again
      const next = await ops(c, id, 3, [
        {
          type: 'add_question',
          question: {
            prompt: 'Again',
            answer_outline: '',
            difficulty: 1,
            category: 'technical',
            requirement_ids: [],
          },
        },
      ]);
      expect(next.body.kit.questions.map((q: { id: string }) => q.id)).toEqual(['q1', 'q4']);
    });

    it('refuses a whole-kit save that would bring back a deleted item under its old id, and stores nothing', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const original = await wholeKit(c, id);
      await ops(c, id, 1, [{ type: 'delete_question', id: 'q2' }]);
      const before = await rawDoc(id);

      const res = await c.put(`/kits/${id}`, { version: 2, kit: original }); // still contains q2
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('BUILDER_CONFLICT');
      expect(res.body.error.message).toMatch(/question q2/);
      expect(await rawDoc(id)).toEqual(before);
    });

    it("treats an item with a new id as the user's own (manual) and keeps the counter above it", async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const kit = await wholeKit(c, id);
      kit.questions.push(question('q10', ['r2'], { category: 'company-fit' }));
      kit.schedule.days[1]!.question_ids.push('q10');
      kit.schedule.days[1]!.minutes += 15;
      expect((await c.put(`/kits/${id}`, { version: 1, kit })).status).toBe(200);
      const state = (await c.get(`/kits/${id}/builder`)).body.builder;
      expect(state.questions.find((q: { id: string }) => q.id === 'q10')).toMatchObject({
        origin: 'manual',
        edited: false,
      });
      expect(state.next_ids.question).toBe(11);
    });

    it('lets a whole-kit save change the number of days, and the state follows', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const kit = await wholeKit(c, id);
      kit.schedule.days_available = 3;
      kit.schedule.days.push({ day: 3, focus: 'Review', question_ids: [], minutes: 30 });
      expect((await c.put(`/kits/${id}`, { version: 1, kit })).status).toBe(200);
      const body = (await c.get(`/kits/${id}/builder`)).body as BuilderDocumentResponse;
      expect(body.builder.requested_days).toBe(3);
      expect(body.builder.days.map((d) => d.day)).toEqual([1, 2, 3]);
      expect(body.builder.days[2]).toMatchObject({ edited: true });
      expect(checkBuilderDocument({ kit: body.kit, state: body.builder }).ok).toBe(true);
    });

    it('keeps the original conflict and ownership answers', async () => {
      const alice = await signUp(h.app);
      const bob = await signUp(h.app);
      const id = await newKit(alice);
      await ops(alice, id, 1, [edit('Newer')]);
      const stale = await alice.put(`/kits/${id}`, { version: 1, kit: makeKit() });
      expect(stale.status).toBe(409);
      expect(stale.body.error.details).toEqual({ current_version: 2 });
      expect((await bob.put(`/kits/${id}`, { version: 99, kit: makeKit() })).status).toBe(404);
    });

    it('concurrent whole-kit saves from one version still produce exactly one winner and a consistent state', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => {
          const kit = makeKit();
          kit.questions[0]!.prompt = `writer ${i}`;
          return c.put(`/kits/${id}`, { version: 1, kit });
        }),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const body = (await c.get(`/kits/${id}/builder`)).body as BuilderDocumentResponse;
      expect(body.version).toBe(2);
      expect(checkBuilderDocument({ kit: body.kit, state: body.builder }).ok).toBe(true);
      expect(body.builder.questions[0]?.edited).toBe(true);
    });
  });
});
