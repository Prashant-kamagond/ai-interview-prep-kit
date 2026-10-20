import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { practiceProgressResponseSchema, type Kit } from '@trao/contracts';
import { makeKit } from '@trao/core/testing';
import { client, createHarness, signUp, type Harness, type TestClient } from './test/harness.js';

function kitWithCards(): Kit {
  const kit = makeKit();
  kit.flashcards = ['f1', 'f2', 'f3'].map((id) => ({
    id,
    front: `Front ${id}`,
    back: `Back ${id}`,
    requirement_ids: ['r1'],
  }));
  return kit;
}

describe('practice progress', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const cards = () => h.db.collection('practice_cards');
  async function newKit(c: TestClient, kit: Kit = kitWithCards()) {
    const res = await c.post('/kits', { kit });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }
  let counter = 0;
  const attempt = () => `attempt-${Date.now().toString(36)}-${(counter++).toString(36)}`;
  const rate = (
    c: TestClient,
    kitId: string,
    cardId: string,
    confidence: unknown,
    attempt_id = attempt(),
  ) => c.put(`/kits/${kitId}/practice/cards/${cardId}`, { confidence, attempt_id });

  describe('authentication and ownership', () => {
    it('requires a signed-in user on every endpoint', async () => {
      const anon = client(h.app);
      const id = '0'.repeat(24);
      expect((await anon.get(`/kits/${id}/practice`)).status).toBe(401);
      expect((await rate(anon, id, 'f1', 2)).status).toBe(401);
      expect((await anon.del(`/kits/${id}/practice`)).status).toBe(401);
    });

    it("never reads, writes or resets another user's progress, answering 404 as if the kit did not exist", async () => {
      const alice = await signUp(h.app);
      const bob = await signUp(h.app);
      const id = await newKit(alice);
      expect((await rate(alice, id, 'f1', 3)).status).toBe(200);

      expect((await bob.get(`/kits/${id}/practice`)).status).toBe(404);
      const attack = await rate(bob, id, 'f1', 1);
      expect(attack.status).toBe(404);
      expect(JSON.stringify(attack.body)).not.toMatch(/Front|Back|confidence/);
      expect((await bob.del(`/kits/${id}/practice`)).status).toBe(404);

      const mine = await alice.get(`/kits/${id}/practice`);
      expect(mine.body.cards).toEqual([
        expect.objectContaining({ card_id: 'f1', confidence: 3, attempts: 1 }),
      ]);
    });

    it('does not create any record for a kit that is not yours', async () => {
      const alice = await signUp(h.app);
      const bob = await signUp(h.app);
      const id = await newKit(alice);
      const before = await cards().countDocuments({ kitId: new ObjectId(id) });
      await rate(bob, id, 'f1', 1);
      expect(await cards().countDocuments({ kitId: new ObjectId(id) })).toBe(before);
    });

    it('treats a missing kit and a malformed id the same way', async () => {
      const c = await signUp(h.app);
      for (const id of [new ObjectId().toHexString(), 'nope', '..%2F..']) {
        expect((await c.get(`/kits/${id}/practice`)).status).toBe(404);
        expect((await rate(c, id, 'f1', 2)).status).toBe(404);
        expect((await c.del(`/kits/${id}/practice`)).status).toBe(404);
      }
    });
  });

  describe('recording and reading', () => {
    it('starts empty, records a rating, and returns exactly what was stored', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const empty = await c.get(`/kits/${id}/practice`);
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual({ kit_id: id, cards: [] });

      const res = await rate(c, id, 'f2', 2);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        duplicate: false,
        card: { card_id: 'f2', confidence: 2, attempts: 1 },
      });
      expect(res.body.card.last_practised_at).toEqual(expect.any(String));

      const now = practiceProgressResponseSchema.parse((await c.get(`/kits/${id}/practice`)).body);
      expect(now.cards).toHaveLength(1);
      expect(now.cards[0]).toMatchObject({ card_id: 'f2', confidence: 2, attempts: 1 });
    });

    it('a later rating replaces the confidence and adds an attempt', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      await rate(c, id, 'f1', 1);
      const second = await rate(c, id, 'f1', 3);
      expect(second.body.card).toMatchObject({ confidence: 3, attempts: 2 });
      expect((await c.get(`/kits/${id}/practice`)).body.cards).toHaveLength(1); // still one record per card
    });

    it('records each card separately', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      for (const [card, level] of [
        ['f1', 1],
        ['f2', 2],
        ['f3', 3],
      ] as const)
        await rate(c, id, card, level);
      const cardsBack = (await c.get(`/kits/${id}/practice`)).body.cards as {
        card_id: string;
        confidence: number;
      }[];
      expect(cardsBack.map((x) => [x.card_id, x.confidence])).toEqual([
        ['f1', 1],
        ['f2', 2],
        ['f3', 3],
      ]);
    });

    it('progress survives signing in again from another client', async () => {
      const email = `practice-${Date.now()}@example.com`;
      const first = await signUp(h.app, email);
      const id = await newKit(first);
      await rate(first, id, 'f1', 2);
      const second = client(h.app);
      const login = await second.post('/auth/login', {
        email,
        password: 'correct horse battery staple',
      });
      expect(login.status).toBe(200);
      expect((await second.get(`/kits/${id}/practice`)).body.cards).toEqual([
        expect.objectContaining({ card_id: 'f1', confidence: 2 }),
      ]);
    });

    it('does not leak internals', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const res = await rate(c, id, 'f1', 2);
      expect(Object.keys(res.body.card).sort()).toEqual([
        'attempts',
        'card_id',
        'confidence',
        'last_practised_at',
      ]);
      const text = JSON.stringify((await c.get(`/kits/${id}/practice`)).body);
      expect(text).not.toMatch(/userId|attempt-|lastAttemptId|"_id"/);
    });
  });

  describe('validation', () => {
    it.each([
      ['no body', undefined],
      ['no confidence', { attempt_id: 'abcd1234' }],
      ['no attempt id', { confidence: 2 }],
      ['confidence 0', { confidence: 0, attempt_id: 'abcd1234' }],
      ['confidence 4', { confidence: 4, attempt_id: 'abcd1234' }],
      ['confidence as text', { confidence: '2', attempt_id: 'abcd1234' }],
      ['a short attempt id', { confidence: 2, attempt_id: 'abc' }],
      ['an attempt id with unsafe characters', { confidence: 2, attempt_id: '../../x y' }],
      ['an operator object as the attempt id', { confidence: 2, attempt_id: { $ne: 'x' } }],
      ['an operator object as the confidence', { confidence: { $gt: 0 }, attempt_id: 'abcd1234' }],
    ])('rejects %s with VALIDATION_ERROR and stores nothing', async (_n, body) => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const res = await c.put(`/kits/${id}/practice/cards/f1`, body as object);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect((await c.get(`/kits/${id}/practice`)).body.cards).toEqual([]);
    });

    it.each(['f99', '$ne', '..', 'f1%00', 'x'.repeat(200)])(
      'answers 404 for a card the kit does not have (%s)',
      async (cardId) => {
        const c = await signUp(h.app);
        const id = await newKit(c);
        const res = await c.put(`/kits/${id}/practice/cards/${encodeURIComponent(cardId)}`, {
          confidence: 2,
          attempt_id: attempt(),
        });
        expect(res.status).toBe(404);
        expect(await cards().countDocuments({ kitId: new ObjectId(id) })).toBe(0);
      },
    );
  });

  describe('duplicates and concurrency', () => {
    it('counts a repeated attempt once and leaves the stored rating alone', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const same = 'one-press-of-a-button';
      const first = await rate(c, id, 'f1', 2, same);
      const again = await rate(c, id, 'f1', 2, same);
      const different = await rate(c, id, 'f1', 3, same); // same attempt id, different body: still the same attempt
      expect(first.body).toMatchObject({ duplicate: false, card: { attempts: 1 } });
      expect(again.body).toMatchObject({ duplicate: true, card: { attempts: 1, confidence: 2 } });
      expect(different.body).toMatchObject({
        duplicate: true,
        card: { attempts: 1, confidence: 2 },
      });
      expect((await c.get(`/kits/${id}/practice`)).body.cards[0]).toMatchObject({
        attempts: 1,
        confidence: 2,
      });
    });

    it('ten simultaneous copies of one attempt are recorded exactly once', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => rate(c, id, 'f1', 1, 'same-attempt-id-123')),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.filter((r) => r.body.duplicate === false)).toHaveLength(1);
      expect(await cards().countDocuments({ kitId: new ObjectId(id), cardId: 'f1' })).toBe(1);
      expect((await c.get(`/kits/${id}/practice`)).body.cards[0].attempts).toBe(1);
    });

    it('simultaneous different attempts are all counted, in one record', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => rate(c, id, 'f2', ((i % 3) + 1) as 1 | 2 | 3)),
      );
      expect(results.every((r) => r.status === 200 && r.body.duplicate === false)).toBe(true);
      expect(await cards().countDocuments({ kitId: new ObjectId(id), cardId: 'f2' })).toBe(1);
      expect((await c.get(`/kits/${id}/practice`)).body.cards[0].attempts).toBe(6);
    });

    it('the very first ratings of many cards, all racing at once, are each counted (none lost to the insert race)', async () => {
      const c = await signUp(h.app);
      const kits = await Promise.all(Array.from({ length: 6 }, () => newKit(c)));
      const all = await Promise.all(
        kits.flatMap((id) =>
          Array.from({ length: 6 }, (_, i) => rate(c, id, 'f1', ((i % 3) + 1) as 1 | 2 | 3)),
        ),
      );
      expect(all.every((r) => r.status === 200 && r.body.duplicate === false)).toBe(true);
      for (const id of kits) {
        expect(await cards().countDocuments({ kitId: new ObjectId(id), cardId: 'f1' })).toBe(1);
        expect((await c.get(`/kits/${id}/practice`)).body.cards[0].attempts).toBe(6);
      }
    });

    it('has a unique index so a record can never be doubled by a race', async () => {
      const indexes = await cards().indexes();
      expect(indexes.find((i) => i.name === 'practice_card_unique')).toMatchObject({
        unique: true,
      });
    });
  });

  describe('kits that change', () => {
    it('stops reporting a flashcard the user deleted, and refuses to rate it', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      await rate(c, id, 'f1', 1);
      await rate(c, id, 'f2', 2);
      const del = await c.post(`/kits/${id}/operations`, {
        version: 1,
        operations: [{ type: 'delete_flashcard', id: 'f1' }],
      });
      expect(del.status).toBe(200);
      const progress = (await c.get(`/kits/${id}/practice`)).body.cards as { card_id: string }[];
      expect(progress.map((x) => x.card_id)).toEqual(['f2']);
      expect((await rate(c, id, 'f1', 2)).status).toBe(404);
    });

    it("keeps a card's rating when its text is edited (the card is the same card)", async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      await rate(c, id, 'f1', 3);
      await c.post(`/kits/${id}/operations`, {
        version: 1,
        operations: [{ type: 'edit_flashcard', id: 'f1', changes: { back: 'A better answer' } }],
      });
      expect((await c.get(`/kits/${id}/practice`)).body.cards[0]).toMatchObject({
        card_id: 'f1',
        confidence: 3,
      });
    });

    it('a flashcard added later is simply not covered yet', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      await rate(c, id, 'f1', 3);
      await c.post(`/kits/${id}/operations`, {
        version: 1,
        operations: [
          { type: 'add_flashcard', flashcard: { front: 'New', back: 'B', requirement_ids: [] } },
        ],
      });
      const ids = ((await c.get(`/kits/${id}/practice`)).body.cards as { card_id: string }[]).map(
        (x) => x.card_id,
      );
      expect(ids).toEqual(['f1']);
      expect((await rate(c, id, 'f4', 2)).status).toBe(200);
    });
  });

  describe('resetting and deleting', () => {
    it("reset forgets this kit's progress only", async () => {
      const c = await signUp(h.app);
      const a = await newKit(c);
      const b = await newKit(c);
      await rate(c, a, 'f1', 1);
      await rate(c, b, 'f1', 2);
      expect((await c.del(`/kits/${a}/practice`)).status).toBe(204);
      expect((await c.get(`/kits/${a}/practice`)).body.cards).toEqual([]);
      expect((await c.get(`/kits/${b}/practice`)).body.cards).toHaveLength(1);
      // and it is possible to start again
      expect((await rate(c, a, 'f1', 3)).body.card).toMatchObject({ attempts: 1, confidence: 3 });
    });

    it('does not touch other users when resetting', async () => {
      const alice = await signUp(h.app);
      const bob = await signUp(h.app);
      const idA = await newKit(alice);
      const idB = await newKit(bob);
      await rate(alice, idA, 'f1', 1);
      await rate(bob, idB, 'f1', 1);
      await alice.del(`/kits/${idA}/practice`);
      expect((await bob.get(`/kits/${idB}/practice`)).body.cards).toHaveLength(1);
    });

    it('deleting a kit deletes its practice progress', async () => {
      const c = await signUp(h.app);
      const id = await newKit(c);
      await rate(c, id, 'f1', 1);
      await rate(c, id, 'f2', 2);
      expect(await cards().countDocuments({ kitId: new ObjectId(id) })).toBe(2);
      expect((await c.del(`/kits/${id}`)).status).toBe(204);
      expect(await cards().countDocuments({ kitId: new ObjectId(id) })).toBe(0);
    });
  });
});
