import { ObjectId } from 'mongodb';
import { afterEach, describe, expect, it } from 'vitest';
import {
  regenerationReportSchema,
  type BuilderDocumentResponse,
  type Kit,
  type ResearchSnapshot,
} from '@trao/contracts';
import { checkBuilderDocument, createBuilderDocument } from '@trao/core';
import { LlmError, buildResearchSnapshot, createLlmClient } from '@trao/pipeline';
import { createFakeProvider } from '../../../packages/pipeline/src/llm/test-support/fake-provider.js';
import {
  HOME_URL,
  byTask,
  makeResearch,
} from '../../../packages/pipeline/src/stages/test-support/fixtures.js';
import { createHarness, signUp, waitFor, type Harness, type TestClient } from './test/harness.js';

const STORED: ResearchSnapshot = buildResearchSnapshot(makeResearch());

/** Two requirements (one technical, one behavioural) and one question in each of two categories. */
function kit(): Kit {
  return {
    source: {
      company: 'Acme',
      company_url: HOME_URL,
      role: 'Backend Engineer',
      location: 'Remote',
      jd_chars: 300,
      researched_at: '2026-02-03T04:05:06.000Z',
      pages_used: [HOME_URL],
    },
    company_brief: { summary: 'Old summary', what_they_do: 'Old description', sources: [HOME_URL] },
    role: {
      title: 'Backend Engineer',
      seniority: 'Senior',
      responsibilities: ['Build'],
      requirements: [
        { id: 'r1', text: 'Node.js', kind: 'technical', priority: 'must' },
        { id: 'r2', text: 'Mentoring', kind: 'behavioural', priority: 'must' },
      ],
    },
    questions: [
      {
        id: 'q1',
        requirement_ids: ['r1'],
        category: 'technical',
        prompt: 'Old technical question',
        answer_outline: '- a',
        difficulty: 2,
      },
      {
        id: 'q2',
        requirement_ids: ['r2'],
        category: 'behavioural',
        prompt: 'Old behavioural question',
        answer_outline: '- a',
        difficulty: 2,
      },
    ],
    flashcards: [{ id: 'f1', front: 'Loop?', back: 'Phases.', requirement_ids: ['r1'] }],
    schedule: {
      days_available: 2,
      days: [
        { day: 1, focus: 'One', question_ids: ['q1'], minutes: 15 },
        { day: 2, focus: 'Two', question_ids: ['q2'], minutes: 15 },
      ],
    },
    coverage: { uncovered_requirement_ids: [], passes: 1 },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const q = (ids: string[], prompt: string) => ({
  requirement_ids: ids,
  prompt,
  answer_outline: '- one\n- two\n- three',
  difficulty: 2,
});

describe('section regeneration jobs', () => {
  const open: Harness[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((h) => h.close()));
  });

  /** Boots the API with a scripted fake model; `handlers` answer each stage like the real model would. */
  async function boot(handlers: Parameters<typeof byTask>[0] = {}) {
    const provider = createFakeProvider(byTask(handlers));
    const h = await createHarness({
      regeneration: {
        createLlm: ({ deadline, clock }) =>
          createLlmClient({
            provider,
            clock,
            deadline,
            random: () => 1,
            maxRetries: 0,
            baseDelayMs: 1,
            maxDelayMs: 1,
          }),
      },
    });
    open.push(h);
    return { h, provider };
  }

  const kitsCollection = (h: Harness) => h.db.collection('kits');
  const rawDoc = (h: Harness, id: string) => kitsCollection(h).findOne({ _id: new ObjectId(id) });
  const jobsCount = (h: Harness) =>
    h.db.collection('generation_jobs').countDocuments({ kind: 'regenerate' });

  async function userId(c: TestClient) {
    return new ObjectId((await c.get('/auth/me')).body.user.id as string);
  }
  /** A kit with its builder state and (optionally) the research snapshot, as generation stores it. */
  async function seed(
    h: Harness,
    c: TestClient,
    options: { research?: ResearchSnapshot | null } = {},
  ) {
    const k = kit();
    const started = createBuilderDocument(k);
    if (!started.ok) throw new Error('fixture invalid');
    const doc = await h.repos.kits.insert(await userId(c), k, {
      builder: started.document.state,
      ...(options.research === null ? {} : { research: options.research ?? STORED }),
    });
    return doc._id.toHexString();
  }
  /** A kit made before research was stored and before the builder existed. */
  async function legacy(h: Harness, c: TestClient) {
    return (await h.repos.kits.insert(await userId(c), kit()))._id.toHexString();
  }

  const regen = (c: TestClient, id: string, body: unknown) =>
    c.post(`/kits/${id}/regenerations`, body as object);
  const finished = async (c: TestClient, jobId: string) =>
    (
      await waitFor(
        () => c.get(`/generation-jobs/${jobId}`),
        (r) => ['succeeded', 'failed'].includes(r.body.job.status),
      )
    ).body.job;
  const builderOf = async (c: TestClient, id: string) =>
    (await c.get(`/kits/${id}/builder`)).body as BuilderDocumentResponse;

  const technical = { section: 'questions', category: 'technical' };
  const goodTechnical = () => ({
    questions: [q(['r1'], 'Fresh technical one'), q(['r1'], 'Fresh technical two')],
  });

  describe('authentication, ownership and validation', () => {
    it('requires a signed-in user', async () => {
      const { h } = await boot();
      const { client } = await import('./test/harness.js');
      expect((await regen(client(h.app), '0'.repeat(24), technical)).status).toBe(401);
    });

    it("never starts or reveals a regeneration for another user's kit", async () => {
      const { h } = await boot({ 'questions:technical': goodTechnical });
      const alice = await signUp(h.app);
      const bob = await signUp(h.app);
      const id = await seed(h, alice);
      const before = await rawDoc(h, id);

      const attempt = await regen(bob, id, technical);
      expect(attempt.status).toBe(404);
      expect(JSON.stringify(attempt.body)).not.toMatch(/Acme|research|REGENERATION/);
      expect(await jobsCount(h)).toBe(0);
      expect(await rawDoc(h, id)).toEqual(before);

      // a job belongs to its owner too
      const started = await regen(alice, id, technical);
      expect(started.status).toBe(202);
      const jobId = started.body.job.id as string;
      expect((await bob.get(`/generation-jobs/${jobId}`)).status).toBe(404);
      await finished(alice, jobId);
    });

    it.each([
      ['no body', undefined],
      ['no section', {}],
      ['an unknown section', { section: 'flashcards' }],
      ['questions without a category', { section: 'questions' }],
      ['an unknown category', { section: 'questions', category: 'trivia' }],
    ])('rejects %s with VALIDATION_ERROR and starts no job', async (_n, body) => {
      const { h } = await boot();
      const c = await signUp(h.app);
      const id = await seed(h, c);
      const res = await regen(c, id, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(await jobsCount(h)).toBe(0);
    });

    it('treats a missing kit and a malformed id the same way', async () => {
      const { h } = await boot();
      const c = await signUp(h.app);
      for (const id of [new ObjectId().toHexString(), 'nope'])
        expect((await regen(c, id, technical)).status).toBe(404);
    });
  });

  describe('missing sources are refused for that section only', () => {
    it('refuses the brief and company-fit questions on a kit without research, naming the reason, and starts no job', async () => {
      const { h, provider } = await boot();
      const c = await signUp(h.app);
      const id = await legacy(h, c);
      const before = await rawDoc(h, id);

      const brief = await regen(c, id, { section: 'brief' });
      expect(brief.status).toBe(422);
      expect(brief.body.error).toMatchObject({
        code: 'REGENERATION_UNAVAILABLE',
        details: { reason: 'RESEARCH_UNAVAILABLE', section: 'brief' },
      });
      expect(brief.body.error.message).toMatch(/not kept/);
      const fit = await regen(c, id, { section: 'questions', category: 'company-fit' });
      expect(fit.status).toBe(422);
      expect(fit.body.error.details).toMatchObject({
        reason: 'RESEARCH_UNAVAILABLE',
        category: 'company-fit',
      });
      expect(await jobsCount(h)).toBe(0);
      expect(provider.calls).toHaveLength(0);
      // the kit is untouched; at most its (deterministic) builder state was created on first use
      const after = await rawDoc(h, id);
      expect(after?.kit).toEqual(before?.kit);
      expect(after?.version).toBe(before?.version);
      expect(after?.research).toBeUndefined();
    });

    it('still regenerates the schedule and technical questions on that same kit', async () => {
      const { h } = await boot({ 'questions:technical': goodTechnical });
      const c = await signUp(h.app);
      const id = await legacy(h, c);
      const schedule = await regen(c, id, { section: 'schedule' });
      expect(schedule.status).toBe(202);
      expect((await finished(c, schedule.body.job.id)).status).toBe('succeeded');
      const questions = await regen(c, id, technical);
      expect(questions.status).toBe(202);
      const job = await finished(c, questions.body.job.id);
      expect(job.status).toBe('succeeded');
      expect((await builderOf(c, id)).research).toEqual({
        status: 'unavailable',
        reason: 'not_persisted',
      });
    });

    it('allows system-design questions when the kit has technical requirements to ask about', async () => {
      const { h } = await boot();
      const c = await signUp(h.app);
      const id = await seed(h, c);
      const res = await regen(c, id, { section: 'questions', category: 'system-design' });
      expect(res.status).toBe(202); // technical requirements exist, so system design has something to ask about
      await finished(c, res.body.job.id);
    });
  });

  describe('a successful regeneration', () => {
    it('replaces one category, keeps the rest, stores kit/state/version together and reports what happened', async () => {
      const { h, provider } = await boot({ 'questions:technical': goodTechnical });
      const c = await signUp(h.app);
      const id = await seed(h, c);
      const before = await builderOf(c, id);

      const started = await regen(c, id, technical);
      expect(started.status).toBe(202);
      expect(started.headers.location).toBe(`/generation-jobs/${started.body.job.id}`);
      expect(started.body).toMatchObject({
        deduplicated: false,
        job: { kind: 'regenerate', report: null },
      });

      const job = await finished(c, started.body.job.id);
      expect(job).toMatchObject({
        kind: 'regenerate',
        status: 'succeeded',
        stage: 'done',
        progress: 100,
        kit_id: id,
        error: null,
      });
      const report = regenerationReportSchema.parse(job.report);
      expect(report).toMatchObject({
        section: 'questions',
        category: 'technical',
        replaced: ['q1'],
        added: ['q3', 'q4'],
        kept: [],
      });
      expect(provider.calls).toHaveLength(1);

      const after = await builderOf(c, id);
      expect(after.version).toBe(before.version + 1);
      expect(after.kit.questions.map((x) => x.id)).toEqual(['q2', 'q3', 'q4']);
      expect(after.kit.questions.find((x) => x.id === 'q2')).toEqual(
        before.kit.questions.find((x) => x.id === 'q2'),
      ); // another category: untouched
      expect(after.kit.flashcards).toEqual(before.kit.flashcards);
      expect(after.kit.company_brief).toEqual(before.kit.company_brief);
      expect(after.research).toEqual(STORED); // the evidence is kept
      expect(checkBuilderDocument({ kit: after.kit, state: after.builder }).ok).toBe(true);
      const raw = await rawDoc(h, id);
      expect(raw?.kit).toEqual(after.kit);
      expect(raw?.builder).toEqual(after.builder);
      expect(raw?.version).toBe(after.version);
    });

    it('exposes progress and the terminal state through the existing job endpoint', async () => {
      const gate = deferred();
      const { h } = await boot({
        'questions:technical': async () => (await gate.promise, goodTechnical()),
      });
      const c = await signUp(h.app);
      const id = await seed(h, c);
      const started = await regen(c, id, technical);
      const running = await waitFor(
        () => c.get(`/generation-jobs/${started.body.job.id}`),
        (r) => r.body.job.status === 'running' && r.body.job.stage === 'generating',
      );
      expect(running.body.job).toMatchObject({
        kind: 'regenerate',
        progress: 30,
        kit_id: null,
        report: null,
      });
      gate.resolve();
      const done = await finished(c, started.body.job.id);
      expect(done.status).toBe('succeeded');
      expect(done.finished_at).toEqual(expect.any(String));
    });

    it('preserves manual, edited and pinned questions through the API, with their ids and flags', async () => {
      const { h } = await boot({ 'questions:technical': goodTechnical });
      const c = await signUp(h.app);
      const id = await seed(h, c);
      const built = await c.post(`/kits/${id}/operations`, {
        version: 1,
        operations: [
          { type: 'edit_question', id: 'q1', changes: { prompt: 'My own technical wording' } },
          {
            type: 'add_question',
            question: {
              prompt: 'Manual technical',
              answer_outline: '',
              difficulty: 1,
              category: 'technical',
              requirement_ids: ['r1'],
            },
          },
          { type: 'set_pin', target: { kind: 'question', id: 'q3' }, pinned: true },
        ],
      });
      expect(built.status).toBe(200);

      const job = await finished(c, (await regen(c, id, technical)).body.job.id);
      expect(job.status).toBe('succeeded');
      const after = await builderOf(c, id);
      const technicalIds = after.kit.questions
        .filter((x) => x.category === 'technical')
        .map((x) => x.id);
      expect(technicalIds).toEqual(['q1', 'q3', 'q4', 'q5']);
      expect(after.kit.questions.find((x) => x.id === 'q1')?.prompt).toBe(
        'My own technical wording',
      );
      expect(after.builder.questions.find((m) => m.id === 'q1')).toMatchObject({
        edited: true,
        origin: 'generated',
      });
      expect(after.builder.questions.find((m) => m.id === 'q3')).toMatchObject({
        origin: 'manual',
      });
      expect(job.report.kept.sort()).toEqual(['q1', 'q3']);
    });

    it('regenerates the brief from the stored research, and keeps an edited brief', async () => {
      const { h } = await boot({
        'company-brief': () => ({
          what_they_do: 'Acme builds payment infrastructure for online merchants.',
          summary: 'Acme processes card payments.',
          claims: [
            {
              text: 'builds payments',
              quote: 'Acme builds payment infrastructure for online merchants',
              source_url: HOME_URL,
            },
          ],
        }),
      });
      const c = await signUp(h.app);
      const id = await seed(h, c);
      const job = await finished(c, (await regen(c, id, { section: 'brief' })).body.job.id);
      expect(job.status).toBe('succeeded');
      expect(job.report).toMatchObject({ section: 'brief', replaced: ['brief'] });
      const after = await builderOf(c, id);
      expect(after.kit.company_brief).toMatchObject({
        summary: 'Acme processes card payments.',
        sources: [HOME_URL],
      });

      // now the user edits it: a second regeneration leaves the edit alone
      await c.post(`/kits/${id}/operations`, {
        version: after.version,
        operations: [{ type: 'edit_brief', changes: { summary: 'Written by me' } }],
      });
      const again = await finished(c, (await regen(c, id, { section: 'brief' })).body.job.id);
      expect(again.status).toBe('succeeded');
      expect(again.report).toMatchObject({ kept: ['brief'], replaced: [] });
      expect((await builderOf(c, id)).kit.company_brief.summary).toBe('Written by me');
    });

    it('regenerates the schedule without a model, keeping pinned days', async () => {
      const { h, provider } = await boot();
      const c = await signUp(h.app);
      const id = await seed(h, c);
      await c.post(`/kits/${id}/operations`, {
        version: 1,
        operations: [{ type: 'set_pin', target: { kind: 'day', day: 1 }, pinned: true }],
      });
      const before = await builderOf(c, id);
      const job = await finished(c, (await regen(c, id, { section: 'schedule' })).body.job.id);
      expect(job.status).toBe('succeeded');
      expect(job.report.days).toEqual({ kept: [1], reallocated: [2] });
      expect(provider.calls).toHaveLength(0);
      const after = await builderOf(c, id);
      expect(after.kit.schedule.days[0]).toEqual(before.kit.schedule.days[0]);
      expect(after.kit.schedule.days_available).toBe(2);
    });

    it('does not create a new version when nothing changes', async () => {
      const { h } = await boot();
      const c = await signUp(h.app);
      const id = await seed(h, c);
      await c.post(`/kits/${id}/operations`, {
        version: 1,
        operations: [1, 2].map((day) => ({
          type: 'set_pin',
          target: { kind: 'day', day },
          pinned: true,
        })),
      });
      const before = await rawDoc(h, id);
      const job = await finished(c, (await regen(c, id, { section: 'schedule' })).body.job.id);
      expect(job.status).toBe('succeeded');
      expect(await rawDoc(h, id)).toEqual(before);
    });

    it('never brings a deleted question back, never reuses an id, across repeated regenerations', async () => {
      const { h } = await boot({
        // the model offers the same questions every time, including the one the user deleted
        'questions:technical': () => ({
          questions: [
            q(['r1'], 'Old technical question'),
            q(['r1'], 'Always offered'),
            q(['r1'], 'Another'),
          ],
        }),
      });
      const c = await signUp(h.app);
      const id = await seed(h, c);
      await c.post(`/kits/${id}/operations`, {
        version: 1,
        operations: [{ type: 'delete_question', id: 'q1' }],
      });

      const everAdded = new Set<string>();
      for (let round = 0; round < 3; round++) {
        const job = await finished(c, (await regen(c, id, technical)).body.job.id);
        expect(job.status).toBe('succeeded');
        for (const added of job.report.added as string[]) {
          expect(everAdded.has(added)).toBe(false);
          everAdded.add(added);
        }
        const now = await builderOf(c, id);
        expect(now.kit.questions.some((x) => x.prompt === 'Old technical question')).toBe(false);
        expect(now.builder.tombstones.map((t) => t.id)).toEqual(['q1']);
        expect(new Set(now.kit.questions.map((x) => x.id)).size).toBe(now.kit.questions.length);
        expect(checkBuilderDocument({ kit: now.kit, state: now.builder }).ok).toBe(true);
      }
      expect(everAdded.size).toBe(6); // two new questions each round, all with fresh ids
      expect(everAdded.has('q1')).toBe(false);
    });
  });

  describe('failure leaves the kit exactly as it was', () => {
    it.each([
      ['a model outage', () => new LlmError('PROVIDER_UNAVAILABLE'), 'LLM_UNAVAILABLE'],
      ['a quota error', () => new LlmError('QUOTA_EXHAUSTED'), 'LLM_QUOTA_EXHAUSTED'],
      [
        'an answer with no usable question',
        () => ({ questions: [q(['r99'], 'Refers to nothing')] }),
        'NO_QUESTIONS_GENERATED',
      ],
    ])('%s', async (_name, reply, code) => {
      const { h } = await boot({ 'questions:technical': reply as never });
      const c = await signUp(h.app);
      const id = await seed(h, c);
      const before = await rawDoc(h, id);
      const job = await finished(c, (await regen(c, id, technical)).body.job.id);
      expect(job).toMatchObject({ status: 'failed', error: { code }, kit_id: null, report: null });
      expect(job.error.message).not.toMatch(/stack|mongodb|secret/i);
      expect(await rawDoc(h, id)).toEqual(before);
    });

    it('an unexpected crash shows only the generic message and changes nothing', async () => {
      const { h } = await boot({
        'questions:technical': () => {
          throw new Error('connect ECONNREFUSED mongodb://admin:hunter2@internal');
        },
      });
      const c = await signUp(h.app);
      const id = await seed(h, c);
      const before = await rawDoc(h, id);
      const job = await finished(c, (await regen(c, id, technical)).body.job.id);
      expect(job.status).toBe('failed');
      expect(JSON.stringify(job)).not.toMatch(/hunter2|ECONNREFUSED|internal/);
      expect(await rawDoc(h, id)).toEqual(before);
    });

    it('a failed write leaves kit, state and version untouched and fails the job cleanly', async () => {
      const { h } = await boot({ 'questions:technical': goodTechnical });
      const c = await signUp(h.app);
      const id = await seed(h, c);
      const before = await rawDoc(h, id);
      const original = h.repos.kits.replaceDocumentIfVersion;
      h.repos.kits.replaceDocumentIfVersion = async () => {
        throw new Error('disk on fire');
      };
      try {
        const job = await finished(c, (await regen(c, id, technical)).body.job.id);
        expect(job).toMatchObject({ status: 'failed', error: { code: 'INTERNAL_ERROR' } });
        expect(JSON.stringify(job)).not.toMatch(/disk on fire/);
      } finally {
        h.repos.kits.replaceDocumentIfVersion = original;
      }
      expect(await rawDoc(h, id)).toEqual(before);
    });

    it('a kit deleted while it ran fails the job and creates nothing', async () => {
      const gate = deferred();
      const { h } = await boot({
        'questions:technical': async () => (await gate.promise, goodTechnical()),
      });
      const c = await signUp(h.app);
      const id = await seed(h, c);
      const started = await regen(c, id, technical);
      await waitFor(
        () => c.get(`/generation-jobs/${started.body.job.id}`),
        (r) => r.body.job.stage === 'generating',
      );
      await c.del(`/kits/${id}`);
      gate.resolve();
      const job = await finished(c, started.body.job.id);
      expect(job.status).toBe('failed');
      expect(await rawDoc(h, id)).toBeNull();
    });
  });

  describe('concurrent edits', () => {
    it('a kit changed while regeneration runs gets a version conflict, and neither the edit nor the kit is overwritten', async () => {
      const gate = deferred();
      const { h } = await boot({
        'questions:technical': async () => (await gate.promise, goodTechnical()),
      });
      const c = await signUp(h.app);
      const id = await seed(h, c);

      const started = await regen(c, id, technical);
      await waitFor(
        () => c.get(`/generation-jobs/${started.body.job.id}`),
        (r) => r.body.job.stage === 'generating',
      );
      // the user edits while the model is working
      const edit = await c.post(`/kits/${id}/operations`, {
        version: 1,
        operations: [
          { type: 'edit_question', id: 'q2', changes: { prompt: 'Edited during regeneration' } },
        ],
      });
      expect(edit.status).toBe(200);
      const edited = await rawDoc(h, id);
      gate.resolve();

      const job = await finished(c, started.body.job.id);
      expect(job).toMatchObject({
        status: 'failed',
        error: { code: 'VERSION_CONFLICT' },
        report: null,
      });
      expect(job.error.message).toMatch(/Nothing was applied/);
      expect(await rawDoc(h, id)).toEqual(edited); // exactly the user's version
      const now = await builderOf(c, id);
      expect(now.kit.questions.map((x) => x.id)).toEqual(['q1', 'q2']);
      expect(now.kit.questions[1]?.prompt).toBe('Edited during regeneration');

      // running it again against the current version works
      const retry = await finished(c, (await regen(c, id, technical)).body.job.id);
      expect(retry.status).toBe('succeeded');
      expect((await builderOf(c, id)).kit.questions.find((x) => x.id === 'q2')?.prompt).toBe(
        'Edited during regeneration',
      );
    });

    it('a client with pending edits sees an ordinary conflict on its next save and recovers through the existing workflow', async () => {
      const { h } = await boot({ 'questions:technical': goodTechnical });
      const c = await signUp(h.app);
      const id = await seed(h, c);
      const job = await finished(c, (await regen(c, id, technical)).body.job.id);
      expect(job.status).toBe('succeeded');
      // the client still holds version 1 and has an unsaved edit
      const stale = await c.post(`/kits/${id}/operations`, {
        version: 1,
        operations: [{ type: 'edit_question', id: 'q2', changes: { prompt: 'My pending edit' } }],
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('VERSION_CONFLICT');
      expect(stale.body.error.details.current.version).toBe(2);
      expect(
        stale.body.error.details.current.kit.questions.map((x: { id: string }) => x.id),
      ).toEqual(['q2', 'q3', 'q4']);
      // nothing was replayed behind its back
      expect((await builderOf(c, id)).kit.questions.find((x) => x.id === 'q2')?.prompt).toBe(
        'Old behavioural question',
      );
    });
  });

  describe('bounded concurrency', () => {
    it('shares one job between identical running requests, and allows one regeneration per kit at a time', async () => {
      const gate = deferred();
      const { h, provider } = await boot({
        'questions:technical': async () => (await gate.promise, goodTechnical()),
      });
      const c = await signUp(h.app);
      const id = await seed(h, c);

      const first = await regen(c, id, technical);
      const same = await regen(c, id, technical);
      expect(same.status).toBe(202);
      expect(same.body).toMatchObject({ deduplicated: true, job: { id: first.body.job.id } });

      const other = await regen(c, id, { section: 'schedule' });
      expect(other.status).toBe(409);
      expect(other.body.error).toMatchObject({
        code: 'REGENERATION_IN_PROGRESS',
        details: { job_id: first.body.job.id },
      });

      gate.resolve();
      expect((await finished(c, first.body.job.id)).status).toBe('succeeded');
      expect(provider.calls).toHaveLength(1);
      expect((await regen(c, id, { section: 'schedule' })).status).toBe(202); // free again
    });

    it('lets different kits regenerate side by side', async () => {
      const gate = deferred();
      const { h } = await boot({
        'questions:technical': async () => (await gate.promise, goodTechnical()),
      });
      const c = await signUp(h.app);
      const a = await seed(h, c);
      const b = await seed(h, c);
      const [x, y] = await Promise.all([regen(c, a, technical), regen(c, b, technical)]);
      expect([x.status, y.status]).toEqual([202, 202]);
      expect(x.body.job.id).not.toBe(y.body.job.id);
      gate.resolve();
      expect((await finished(c, x.body.job.id)).status).toBe('succeeded');
      expect((await finished(c, y.body.job.id)).status).toBe('succeeded');
    });
  });

  describe('regression: existing behaviour', () => {
    it('a regeneration cannot be submitted through the operations endpoint', async () => {
      const { h } = await boot();
      const c = await signUp(h.app);
      const id = await seed(h, c);
      const res = await c.post(`/kits/${id}/operations`, {
        version: 1,
        operations: [
          {
            section: 'questions',
            category: 'technical',
            questions: [q(['r1'], 'Injected as generated')],
          },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_OPERATION');
      expect((await rawDoc(h, id))?.version).toBe(1);
    });

    it('whole-kit PUT still works on a regenerated kit and keeps its builder state', async () => {
      const { h } = await boot({ 'questions:technical': goodTechnical });
      const c = await signUp(h.app);
      const id = await seed(h, c);
      await finished(c, (await regen(c, id, technical)).body.job.id);
      const current = (await c.get(`/kits/${id}`)).body;
      const edited: Kit = JSON.parse(JSON.stringify(current.kit));
      edited.company_brief.summary = 'Changed through PUT';
      const put = await c.put(`/kits/${id}`, { version: current.version, kit: edited });
      expect(put.status).toBe(200);
      const after = await builderOf(c, id);
      expect(after.builder.questions.map((m) => m.id)).toEqual(['q2', 'q3', 'q4']);
      expect(after.builder.next_ids.question).toBe(5);
      expect(after.research).toEqual(STORED);
    });
  });
});
