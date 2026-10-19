import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kit } from '@trao/contracts';
import { makeKit, question, req } from '@trao/core/testing';
import { createHarness, signUp, type Harness } from './test/harness.js';

describe('kits', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('creates, lists, reads, updates and deletes a kit', async () => {
    const c = await signUp(h.app);

    const created = await c.post('/kits', { kit: makeKit() });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: expect.any(String), version: 1, warnings: [] });
    const id = created.body.id as string;

    const list = await c.get('/kits');
    expect(list.status).toBe(200);
    expect(list.body.kits).toEqual([
      expect.objectContaining({ id, company: 'Acme', role: 'Backend Engineer', version: 1 }),
    ]);
    expect(JSON.stringify(list.body)).not.toMatch(/userId|questions/);

    const read = await c.get(`/kits/${id}`);
    expect(read.status).toBe(200);
    expect(read.body.kit).toEqual(makeKit());
    expect(read.body.version).toBe(1);
    expect(read.body.userId).toBeUndefined();

    const edited: Kit = makeKit();
    edited.questions[0]!.prompt = 'Edited by the user';
    const updated = await c.put(`/kits/${id}`, { version: 1, kit: edited });
    expect(updated.status).toBe(200);
    expect(updated.body.version).toBe(2);
    expect((await c.get(`/kits/${id}`)).body.kit.questions[0].prompt).toBe('Edited by the user');

    expect((await c.del(`/kits/${id}`)).status).toBe(204);
    expect((await c.get(`/kits/${id}`)).status).toBe(404);
    expect((await c.get('/kits')).body.kits).toEqual([]);
  });

  describe('validation', () => {
    it.each([
      ['no body', undefined],
      ['no kit key', {}],
    ])('rejects a malformed request: %s', async (_n, body) => {
      const c = await signUp(h.app);
      const res = await c.post('/kits', body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a structurally invalid kit with the offending path', async () => {
      const c = await signUp(h.app);
      const bad = makeKit();
      bad.questions[0]!.difficulty = 4;
      const res = await c.post('/kits', { kit: bad });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('KIT_INVALID');
      expect(res.body.error.details).toContainEqual(
        expect.objectContaining({ code: 'SCHEMA_INVALID', path: 'questions[0].difficulty' }),
      );
    });

    it('rejects a kit with a dangling reference', async () => {
      const c = await signUp(h.app);
      const bad = makeKit();
      bad.schedule.days[0]!.question_ids = ['q404'];
      const res = await c.post('/kits', { kit: bad });
      expect(res.status).toBe(422);
      expect(res.body.error.details).toContainEqual(
        expect.objectContaining({ code: 'UNKNOWN_QUESTION_REFERENCE' }),
      );
    });

    it('rejects a coverage section that disagrees with the questions', async () => {
      const c = await signUp(h.app);
      const bad = makeKit();
      bad.coverage.uncovered_requirement_ids = ['r2'];
      expect((await c.post('/kits', { kit: bad })).status).toBe(422);
    });

    it('saves an edited draft that has an unscheduled question, reporting a warning', async () => {
      const c = await signUp(h.app);
      const draft = makeKit();
      draft.questions.push(question('q3', ['r1']));
      const res = await c.post('/kits', { kit: draft });
      expect(res.status).toBe(201);
      expect(res.body.warnings).toEqual([
        expect.objectContaining({ code: 'UNSCHEDULED_QUESTION', severity: 'warning' }),
      ]);
    });

    it('saves an honestly reported coverage gap: it is not a reference error', async () => {
      const c = await signUp(h.app);
      const kit = makeKit();
      kit.role.requirements = [req('r1', 'must'), req('r2', 'nice')];
      kit.questions = [question('q2', ['r2'])];
      kit.flashcards = [];
      kit.schedule = {
        days_available: 1,
        days: [{ day: 1, focus: 'Nice-to-have', question_ids: ['q2'], minutes: 15 }],
      };
      kit.coverage = { uncovered_requirement_ids: ['r1'], passes: 3 };
      const res = await c.post('/kits', { kit });
      expect(res.status).toBe(201);
      expect(res.body.warnings).toEqual([]);
    });

    it('rejects an oversized request body', async () => {
      const c = await signUp(h.app);
      const kit = makeKit();
      kit.company_brief.summary = 'x'.repeat(1_200_000);
      const res = await c.post('/kits', { kit });
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('rejects malformed JSON with a safe error', async () => {
      const c = await signUp(h.app);
      const res = await c.agent
        .post('/kits')
        .set('Origin', 'http://localhost:3000')
        .set('Content-Type', 'application/json')
        .send('{"kit": ');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_JSON');
    });

    it('requires a positive integer version on update', async () => {
      const c = await signUp(h.app);
      const { body } = await c.post('/kits', { kit: makeKit() });
      for (const version of [undefined, 0, -1, 1.5, '1']) {
        const res = await c.put(`/kits/${body.id}`, { version, kit: makeKit() });
        expect(res.status).toBe(400);
      }
    });
  });

  describe('ownership', () => {
    it("never exposes or modifies another user's kit, and answers 404 as if it did not exist", async () => {
      const alice = await signUp(h.app);
      const bob = await signUp(h.app);
      const { body } = await alice.post('/kits', { kit: makeKit() });
      const id = body.id as string;

      const stolen = makeKit();
      stolen.questions[0]!.prompt = 'Bob was here';

      const missingId = new ObjectId().toHexString();
      for (const target of [id, missingId]) {
        const get = await bob.get(`/kits/${target}`);
        const put = await bob.put(`/kits/${target}`, { version: 1, kit: stolen });
        const del = await bob.del(`/kits/${target}`);
        // Identical to a genuinely missing kit, so existence is not leaked.
        for (const res of [get, put, del]) {
          expect(res.status).toBe(404);
          expect(res.body.error.code).toBe('NOT_FOUND');
        }
      }

      expect((await bob.get('/kits')).body.kits).toEqual([]);
      const intact = await alice.get(`/kits/${id}`);
      expect(intact.body.version).toBe(1);
      expect(intact.body.kit).toEqual(makeKit());
    });

    it('treats a malformed id exactly like a missing one', async () => {
      const c = await signUp(h.app);
      const res = await c.get('/kits/not-an-object-id');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('optimistic concurrency', () => {
    it('rejects a stale update with 409 and leaves the newer data intact', async () => {
      const c = await signUp(h.app);
      const { body } = await c.post('/kits', { kit: makeKit() });
      const id = body.id as string;

      const first = makeKit();
      first.questions[0]!.prompt = 'Newer edit';
      expect((await c.put(`/kits/${id}`, { version: 1, kit: first })).status).toBe(200);

      const stale = makeKit();
      stale.questions[0]!.prompt = 'Stale overwrite';
      const res = await c.put(`/kits/${id}`, { version: 1, kit: stale });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('VERSION_CONFLICT');
      expect(res.body.error.details).toEqual({ current_version: 2 });

      const now = await c.get(`/kits/${id}`);
      expect(now.body.version).toBe(2);
      expect(now.body.kit.questions[0].prompt).toBe('Newer edit');
    });

    it('lets exactly one of several concurrent updates from the same version win', async () => {
      const c = await signUp(h.app);
      const { body } = await c.post('/kits', { kit: makeKit() });
      const id = body.id as string;

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => {
          const kit = makeKit();
          kit.questions[0]!.prompt = `writer ${i}`;
          return c.put(`/kits/${id}`, { version: 1, kit });
        }),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(7);
      expect((await c.get(`/kits/${id}`)).body.version).toBe(2);
    });

    it("does not apply a conflicting update to someone else's kit as a conflict leak", async () => {
      const alice = await signUp(h.app);
      const bob = await signUp(h.app);
      const { body } = await alice.post('/kits', { kit: makeKit() });
      const res = await bob.put(`/kits/${body.id}`, { version: 99, kit: makeKit() });
      expect(res.status).toBe(404); // not 409: a conflict would reveal that the kit exists
    });
  });
});
