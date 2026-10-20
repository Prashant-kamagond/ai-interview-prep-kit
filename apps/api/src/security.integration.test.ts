import { ObjectId } from 'mongodb';
import { afterEach, describe, expect, it } from 'vitest';
import type { Kit } from '@trao/contracts';
import { makeKit } from '@trao/core/testing';
import { MAX_ACTIVE_JOBS_PER_USER, MAX_ACTIVE_JOBS_TOTAL } from './services/jobs.js';
import {
  PASSWORD,
  TEST_ORIGIN,
  client,
  controllableRunner,
  createHarness,
  signUp,
  uniqueEmail,
  type Harness,
  type TestClient,
} from './test/harness.js';

/**
 * Cross-cutting protections, checked through the real HTTP API and MongoDB: the CSRF origin check on the
 * newer endpoints, operator-style injection, body size, and the limits on concurrent jobs.
 */
describe('security regressions', () => {
  const open: Harness[] = [];
  async function boot(runner?: ReturnType<typeof controllableRunner>['runner']) {
    const h = await createHarness(runner ? { runner } : {});
    open.push(h);
    return h;
  }
  afterEach(async () => {
    await Promise.all(open.splice(0).map((h) => h.close()));
  });

  const body = (n: number) => ({
    jd: `Senior Backend Engineer ${n}\n\nMust have 5 years of Node.`,
    company_url: 'http://localhost:8099/acme/',
    days: 5,
  });

  async function kitFor(c: TestClient, kit: Kit = makeKit()) {
    const res = await c.post('/kits', { kit });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  describe('CSRF origin check on the builder, regeneration and practice endpoints', () => {
    const attempts = (id: string, origin: string | undefined) => {
      const withOrigin = (req: { set(k: string, v: string): unknown }) =>
        origin === undefined ? req : req.set('Origin', origin);
      return (h: Harness, c: TestClient) => {
        const agent = c.agent;
        return [
          ['operations', withOrigin(agent.post(`/kits/${id}/operations`)) as unknown],
          ['regenerations', withOrigin(agent.post(`/kits/${id}/regenerations`)) as unknown],
          ['practice rating', withOrigin(agent.put(`/kits/${id}/practice/cards/f1`)) as unknown],
          ['practice reset', withOrigin(agent.delete(`/kits/${id}/practice`)) as unknown],
        ] as [
          string,
          { send(b: object): Promise<{ status: number; body: { error: { code: string } } }> },
        ][];
      };
    };

    it.each([
      ['no Origin header', undefined],
      ['another site', 'https://evil.example'],
      ['a look-alike of the real origin', `${TEST_ORIGIN}.evil.example`],
      ['the right host on another port', 'http://localhost:3001'],
    ])('rejects every state-changing request with %s, and changes nothing', async (_n, origin) => {
      const h = await boot();
      const c = await signUp(h.app);
      const id = await kitFor(c);
      const before = await h.db.collection('kits').findOne({ _id: new ObjectId(id) });
      for (const [name, request] of attempts(id, origin)(h, c)) {
        const res = await request.send({
          version: 1,
          operations: [{ type: 'set_pin', target: { kind: 'brief' }, pinned: true }],
          section: 'schedule',
          confidence: 2,
          attempt_id: 'abcd12345678',
        });
        expect(res.status, name).toBe(403);
        expect(res.body.error.code, name).toBe('CSRF_ORIGIN_REJECTED');
      }
      expect(await h.db.collection('kits').findOne({ _id: new ObjectId(id) })).toEqual(before);
      expect(await h.db.collection('practice_cards').countDocuments({})).toBe(0);
      expect(await h.db.collection('generation_jobs').countDocuments({})).toBe(0);
    });
  });

  describe('operator-style injection never reaches the database', () => {
    it.each([
      [
        'login with operator objects',
        '/auth/login',
        { email: { $ne: null }, password: { $ne: null } },
      ],
      [
        'login with an operator as the password',
        '/auth/login',
        { email: 'a@example.com', password: { $gt: '' } },
      ],
      [
        'register with an operator as the email',
        '/auth/register',
        { email: { $regex: '.*' }, password: PASSWORD },
      ],
      [
        'register with an array as the email',
        '/auth/register',
        { email: ['a@example.com'], password: PASSWORD },
      ],
    ])('%s is a validation error, not a 500 and not a login', async (_n, path, payload) => {
      const h = await boot();
      const res = await client(h.app).post(path, payload);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('operator-looking ids in the path are ordinary "not found"', async () => {
      const h = await boot();
      const c = await signUp(h.app);
      for (const id of ['%7B%22%24ne%22%3Anull%7D', '$ne', '[$ne]=1', '..']) {
        for (const path of [
          `/kits/${id}`,
          `/kits/${id}/builder`,
          `/kits/${id}/practice`,
          `/generation-jobs/${id}`,
        ]) {
          const res = await c.get(path);
          expect(res.status, path).toBe(404);
        }
      }
    });

    it('operator objects in kit, operation and rating bodies are rejected as invalid', async () => {
      const h = await boot();
      const c = await signUp(h.app);
      const id = await kitFor(c);
      expect((await c.post('/kits', { kit: { $where: '1' } })).status).toBe(422);
      expect(
        (await c.post(`/kits/${id}/operations`, { version: { $gt: 0 }, operations: [] })).status,
      ).toBe(400);
      expect(
        (await c.post(`/kits/${id}/operations`, { version: 1, operations: [{ $set: { x: 1 } }] }))
          .status,
      ).toBe(400);
      expect(
        (
          await c.put(`/kits/${id}/practice/cards/f1`, {
            confidence: { $gt: 0 },
            attempt_id: { $ne: 'x' },
          })
        ).status,
      ).toBe(400);
      expect(
        (await c.post(`/kits/${id}/regenerations`, { section: { $ne: 'brief' } })).status,
      ).toBe(400);
    });
  });

  describe('request size', () => {
    it('refuses an oversized operations body with 413 and does not apply it', async () => {
      const h = await boot();
      const c = await signUp(h.app);
      const id = await kitFor(c);
      const res = await c.post(`/kits/${id}/operations`, {
        version: 1,
        operations: [{ type: 'edit_brief', changes: { summary: 'x'.repeat(1_200_000) } }],
      });
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
      expect((await h.db.collection('kits').findOne({ _id: new ObjectId(id) }))?.version).toBe(1);
    });

    it('limits a single field well below the body limit', async () => {
      const h = await boot();
      const c = await signUp(h.app);
      const id = await kitFor(c);
      const res = await c.post(`/kits/${id}/operations`, {
        version: 1,
        operations: [{ type: 'edit_brief', changes: { summary: 'x'.repeat(5_001) } }],
      });
      expect(res.status).toBe(400);
    });
  });

  describe('errors reveal nothing', () => {
    it('every error has the one structured shape with a request id and no stack, path or driver text', async () => {
      const h = await boot();
      const c = await signUp(h.app);
      const responses = [
        await c.get('/kits/not-an-id'),
        await c.post('/kits/000000000000000000000000/operations', { version: 1, operations: [] }),
        await c.put('/kits/000000000000000000000000/practice/cards/f1', {}),
        await client(h.app).get('/kits'),
        await c.get('/no-such-route'),
      ];
      for (const res of responses) {
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(Object.keys(res.body)).toEqual(['error']);
        expect(res.body.error.request_id).toEqual(expect.any(String));
        expect(JSON.stringify(res.body)).not.toMatch(
          /at \S+ \(|node_modules|\.ts:|mongodb|ECONN|stack/i,
        );
      }
    });
  });

  describe('concurrent job limits (the server runs jobs in-process)', () => {
    it(`a user may have ${MAX_ACTIVE_JOBS_PER_USER} jobs running, and the next one is refused`, async () => {
      const ctl = controllableRunner();
      const h = await boot(ctl.runner);
      const c = await signUp(h.app);
      for (let i = 0; i < MAX_ACTIVE_JOBS_PER_USER; i++) {
        expect((await c.post('/generation-jobs', body(i))).status).toBe(202);
      }
      const refused = await c.post('/generation-jobs', body(99));
      expect(refused.status).toBe(429);
      expect(refused.body.error.code).toBe('TOO_MANY_ACTIVE_JOBS');
      expect(await h.db.collection('generation_jobs').countDocuments({ active: true })).toBe(
        MAX_ACTIVE_JOBS_PER_USER,
      );
      ctl.fail(new Error('end of test'));
      await h.jobs.settled();
    });

    it('an identical request at the limit joins the running job instead of being refused', async () => {
      const ctl = controllableRunner();
      const h = await boot(ctl.runner);
      const c = await signUp(h.app);
      const first = await c.post('/generation-jobs', body(0));
      for (let i = 1; i < MAX_ACTIVE_JOBS_PER_USER; i++) await c.post('/generation-jobs', body(i));
      const same = await c.post('/generation-jobs', body(0));
      expect(same.status).toBe(202);
      expect(same.body).toMatchObject({ deduplicated: true, job: { id: first.body.job.id } });
      ctl.fail(new Error('end of test'));
      await h.jobs.settled();
    });

    it("one user's jobs never block another user, and a slot frees when a job finishes", async () => {
      const ctl = controllableRunner();
      const h = await boot(ctl.runner);
      const a = await signUp(h.app);
      const b = await signUp(h.app, uniqueEmail());
      for (let i = 0; i < MAX_ACTIVE_JOBS_PER_USER; i++) await a.post('/generation-jobs', body(i));
      expect((await a.post('/generation-jobs', body(50))).status).toBe(429);
      expect((await b.post('/generation-jobs', body(60))).status).toBe(202);
      ctl.fail(new Error('end of test'));
      await h.jobs.settled();
      expect((await a.post('/generation-jobs', body(70))).status).toBe(202); // slots are free again
      await h.jobs.settled();
    });

    it(`when ${MAX_ACTIVE_JOBS_TOTAL} jobs are already running the server says it is busy, with a retry-friendly code`, async () => {
      const ctl = controllableRunner();
      const h = await boot(ctl.runner);
      const c = await signUp(h.app);
      const now = new Date();
      await h.db.collection('generation_jobs').insertMany(
        Array.from({ length: MAX_ACTIVE_JOBS_TOTAL }, (_, i) => ({
          _id: new ObjectId(),
          userId: new ObjectId(),
          status: 'running',
          active: true,
          inputHash: `other-${i}`,
          input: body(i),
          kind: 'generate',
          stage: null,
          progress: null,
          kitId: null,
          error: null,
          createdAt: now,
          updatedAt: now,
          startedAt: now,
          finishedAt: null,
        })),
      );
      const res = await c.post('/generation-jobs', body(1));
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVER_BUSY');
      expect(ctl.calls).toHaveLength(0);
      ctl.fail(new Error('end of test'));
    });

    it('counts regeneration jobs too', async () => {
      const ctl = controllableRunner();
      const h = await boot(ctl.runner);
      const c = await signUp(h.app);
      for (let i = 0; i < MAX_ACTIVE_JOBS_PER_USER; i++) await c.post('/generation-jobs', body(i));
      const id = await kitFor(c);
      const res = await c.post(`/kits/${id}/regenerations`, { section: 'schedule' });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('TOO_MANY_ACTIVE_JOBS');
      ctl.fail(new Error('end of test'));
      await h.jobs.settled();
    });
  });
});
