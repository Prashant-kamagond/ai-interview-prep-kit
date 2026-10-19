import { describe, expect, it } from 'vitest';
import type { Question, Requirement } from '@trao/contracts';
import { buildCoverage } from '@trao/core';
import { LlmError } from '../llm/errors.js';
import { MAX_COVERAGE_PASSES, closeCoverageGaps, type GapGenerator } from './coverage-loop.js';
import type { DraftQuestion } from './questions.js';

const REQS: Requirement[] = [
  { id: 'r1', text: 'Node.js', kind: 'technical', priority: 'must' },
  { id: 'r2', text: 'PostgreSQL', kind: 'technical', priority: 'must' },
  { id: 'r3', text: 'Mentoring', kind: 'behavioural', priority: 'must' },
  { id: 'r4', text: 'Kafka', kind: 'technical', priority: 'nice' },
  { id: 'r5', text: 'Rust', kind: 'domain', priority: 'nice' },
];

const question = (
  id: string,
  ids: string[],
  category: Question['category'] = 'technical',
): Question => ({
  id,
  requirement_ids: ids,
  category,
  prompt: `Prompt ${id}`,
  answer_outline: '- a',
  difficulty: 2,
});

const draft = (
  ids: string[],
  category: DraftQuestion['category'] = 'technical',
  prompt = `Gap ${ids.join('+')}`,
): DraftQuestion => ({
  category,
  requirement_ids: ids,
  prompt,
  answer_outline: '- a',
  difficulty: 2,
});

/** Records every call and answers by consulting a script. */
function generator(
  script: (group: Parameters<GapGenerator>[0], call: number) => DraftQuestion[] | Error,
) {
  const calls: Parameters<GapGenerator>[0][] = [];
  const generate: GapGenerator = async (group) => {
    calls.push(group);
    const out = script(group, calls.length);
    if (out instanceof Error) throw out;
    return out;
  };
  return { generate, calls };
}

const allCovered = [
  question('q1', ['r1']),
  question('q2', ['r2']),
  question('q3', ['r3'], 'behavioural'),
  question('q4', ['r4', 'r5']),
];

describe('closeCoverageGaps', () => {
  it('does nothing when the draft already covers everything: one check, no generation', async () => {
    const { generate, calls } = generator(() => []);
    const r = await closeCoverageGaps({ requirements: REQS, questions: allCovered, generate });
    expect(calls).toHaveLength(0);
    expect(r.passes).toBe(1);
    expect(r.stoppedBecause).toBe('covered');
    expect(r.report.uncovered_requirement_ids).toEqual([]);
    expect(r.questions).toEqual(allCovered);
    expect(r.limitations).toEqual([]);
  });

  it('closes a gap in one round, targeting exactly the uncovered requirements', async () => {
    const draftQs = [
      question('q1', ['r1']),
      question('q3', ['r3'], 'behavioural'),
      question('q4', ['r4', 'r5']),
    ];
    const { generate, calls } = generator(() => [draft(['r2'])]);
    const r = await closeCoverageGaps({ requirements: REQS, questions: draftQs, generate });

    expect(calls).toEqual([{ category: 'technical', requirementIds: ['r2'] }]);
    expect(r.passes).toBe(2);
    expect(r.stoppedBecause).toBe('covered');
    expect(r.report.uncovered_requirement_ids).toEqual([]);
    expect(r.rounds).toEqual([
      expect.objectContaining({ pass: 2, targeted: ['r2'], questionsAdded: 1, stillUncovered: [] }),
    ]);
  });

  it('assigns new ids that continue the numbering and never collide', async () => {
    const draftQs = [question('q7', ['r1']), question('q2', ['r3'], 'behavioural')];
    const { generate } = generator((group) =>
      group.category === 'technical' ? [draft(['r2'])] : [draft(['r3'], 'behavioural')],
    );
    const r = await closeCoverageGaps({ requirements: REQS, questions: draftQs, generate });
    const ids = r.questions.map((q) => q.id);
    expect(ids.slice(0, 2)).toEqual(['q7', 'q2']);
    expect(ids[2]).toBe('q8');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the original questions untouched and marks new ones with their category', async () => {
    const draftQs = [question('q1', ['r1'])];
    const { generate } = generator(() => [draft(['r2', 'r4', 'r5'], 'technical')]);
    const r = await closeCoverageGaps({ requirements: REQS, questions: draftQs, generate });
    expect(r.questions[0]).toEqual(draftQs[0]);
    expect(r.questions[1]).toMatchObject({
      category: 'technical',
      requirement_ids: ['r2', 'r4', 'r5'],
    });
  });

  it('can need a second round, and counts three checks in total', async () => {
    const draftQs = [question('q1', ['r1'])];
    const { generate, calls } = generator((_group, call) => {
      if (call === 1) return [draft(['r2'])]; // round 1, technical group: closes only r2
      if (call === 2) return []; // round 1, behavioural group: nothing usable
      if (call === 3) return [draft(['r4', 'r5'])]; // round 2, technical group
      return [draft(['r3'], 'behavioural')]; // round 2, behavioural group
    });
    const r = await closeCoverageGaps({ requirements: REQS, questions: draftQs, generate });
    expect(r.passes).toBe(3);
    expect(r.rounds).toHaveLength(2);
    expect(r.stoppedBecause).toBe('covered');
    expect(calls.length).toBe(4);
  });

  it('stops at the pass budget and reports what is still uncovered, never claiming success', async () => {
    const draftQs: Question[] = [];
    // Each round closes exactly one must-have (so there is progress every time), and the budget
    // runs out while one must-have is still open.
    const { generate } = generator((_group, call) => {
      if (call === 1) return [draft(['r1'])]; // round 1, technical group
      if (call === 3) return [draft(['r2'])]; // round 2, technical group
      return []; // the behavioural group never produces anything
    });
    const r = await closeCoverageGaps({
      requirements: REQS,
      questions: draftQs,
      generate,
      maxPasses: 3,
    });
    expect(r.passes).toBe(3);
    expect(r.stoppedBecause).toBe('budget');
    expect(r.report.uncovered_requirement_ids.length).toBeGreaterThan(0);
    expect(r.limitations.join(' ')).toMatch(/still not covered|no question/i);
    expect(r.limitations.join(' ')).toMatch(/3 coverage checks/);
  });

  it('never exceeds the default budget of three coverage checks (draft plus two rounds)', async () => {
    expect(MAX_COVERAGE_PASSES).toBe(3);
    let calls = 0;
    const generate: GapGenerator = async () => {
      calls++;
      return [draft([`r${calls}`], 'technical', `Unique gap ${calls}`)];
    };
    const r = await closeCoverageGaps({ requirements: REQS, questions: [], generate });
    expect(r.passes).toBeLessThanOrEqual(3);
    expect(r.rounds.length).toBeLessThanOrEqual(2);
  });

  it('stops when a round makes no progress, without spending the last pass', async () => {
    const draftQs = [question('q1', ['r1'])];
    const { generate, calls } = generator(() => [
      draft(['r1'], 'technical', 'Another Node question'),
    ]); // covers nothing new
    const r = await closeCoverageGaps({ requirements: REQS, questions: draftQs, generate });
    expect(r.stoppedBecause).toBe('no-progress');
    expect(r.passes).toBe(2);
    expect(calls.length).toBeLessThanOrEqual(2); // technical + behavioural groups of ONE round
    expect(r.limitations.join(' ')).toMatch(/no progress/i);
  });

  it('ignores references to requirements that do not exist: they cannot count as coverage', async () => {
    const { generate } = generator(() => [draft(['r999', 'ghost'])]);
    const r = await closeCoverageGaps({ requirements: REQS, questions: [], generate });
    expect(r.stoppedBecause).toBe('no-progress');
    expect(r.report.uncovered_requirement_ids).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
  });

  it('does not spend model calls when only nice-to-haves are uncovered, and says so', async () => {
    const draftQs = [
      question('q1', ['r1']),
      question('q2', ['r2']),
      question('q3', ['r3'], 'behavioural'),
    ];
    const { generate, calls } = generator(() => [draft(['r4'])]);
    const r = await closeCoverageGaps({ requirements: REQS, questions: draftQs, generate });
    expect(calls).toHaveLength(0);
    expect(r.passes).toBe(1);
    expect(r.stoppedBecause).toBe('only-nice-uncovered');
    expect(r.report.uncovered_requirement_ids).toEqual(['r4', 'r5']);
    expect(r.limitations.join(' ')).toMatch(/nice-to-have/i);
  });

  it('includes uncovered nice-to-haves in a round that exists because of a must-have gap', async () => {
    const draftQs = [question('q2', ['r2']), question('q3', ['r3'], 'behavioural')];
    const { generate, calls } = generator(() => [draft(['r1', 'r4', 'r5'])]);
    await closeCoverageGaps({ requirements: REQS, questions: draftQs, generate });
    expect(calls[0]).toEqual({ category: 'technical', requirementIds: ['r1', 'r4', 'r5'] });
  });

  it('groups gaps by kind: technical and domain together, behavioural separately', async () => {
    const { generate, calls } = generator((group) =>
      group.category === 'behavioural'
        ? [draft(['r3'], 'behavioural')]
        : [draft(['r1', 'r2', 'r4', 'r5'])],
    );
    await closeCoverageGaps({ requirements: REQS, questions: [], generate });
    expect(calls).toEqual([
      { category: 'technical', requirementIds: ['r1', 'r2', 'r4', 'r5'] },
      { category: 'behavioural', requirementIds: ['r3'] },
    ]);
  });

  it('handles a role with no requirements: one check and nothing to do', async () => {
    const { generate, calls } = generator(() => []);
    const r = await closeCoverageGaps({ requirements: [], questions: [], generate });
    expect(calls).toHaveLength(0);
    expect(r.passes).toBe(1);
    expect(r.stoppedBecause).toBe('no-requirements');
  });

  it('allows a smaller budget: with one pass it never generates and reports the gap', async () => {
    const { generate, calls } = generator(() => [draft(['r1'])]);
    const r = await closeCoverageGaps({
      requirements: REQS,
      questions: [],
      generate,
      maxPasses: 1,
    });
    expect(calls).toHaveLength(0);
    expect(r.stoppedBecause).toBe('budget');
    expect(r.passes).toBe(1);
  });

  it('does not count covering only a nice-to-have as progress, so it spends no further pass', async () => {
    const { generate, calls } = generator(() => [draft(['r4'])]);
    const r = await closeCoverageGaps({ requirements: REQS, questions: [], generate });
    expect(r.stoppedBecause).toBe('no-progress');
    expect(r.passes).toBe(2);
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it('is decided by the deterministic checker, whatever the generator claims', async () => {
    // The generator returns a question that merely mentions a nice-to-have: must-haves stay open.
    const { generate } = generator(() => [draft(['r4'])]);
    const r = await closeCoverageGaps({ requirements: REQS, questions: [], generate });
    expect(r.report.uncovered_must_ids.length).toBeGreaterThan(0);
    expect(r.stoppedBecause).not.toBe('covered');
  });

  describe('failures', () => {
    it('stops with a clear limitation when the model cannot be used, keeping what it has', async () => {
      const draftQs = [question('q1', ['r1'])];
      const { generate } = generator(() => new LlmError('RATE_LIMITED'));
      const r = await closeCoverageGaps({ requirements: REQS, questions: draftQs, generate });
      expect(r.stoppedBecause).toBe('failed');
      expect(r.passes).toBe(1);
      expect(r.questions).toEqual(draftQs);
      expect(r.report.uncovered_must_ids).toEqual(['r2', 'r3']);
      expect(r.limitations.join(' ')).toMatch(/RATE_LIMITED|rate-limited/i);
    });

    it('keeps the questions from a group that worked when another group failed, and still re-checks', async () => {
      const { generate } = generator((group) =>
        group.category === 'technical'
          ? [draft(['r1', 'r2', 'r4', 'r5'])]
          : new LlmError('TIMEOUT'),
      );
      const r = await closeCoverageGaps({ requirements: REQS, questions: [], generate });
      expect(r.passes).toBe(2);
      expect(r.report.uncovered_requirement_ids).toEqual(['r3']);
      expect(r.stoppedBecause).toBe('failed');
    });

    it('rethrows errors that make the whole run pointless', async () => {
      for (const code of [
        'AUTH_FAILED',
        'QUOTA_EXHAUSTED',
        'BUDGET_EXHAUSTED',
        'MODEL_NOT_FOUND',
      ] as const) {
        const { generate } = generator(() => new LlmError(code));
        await expect(
          closeCoverageGaps({ requirements: REQS, questions: [], generate }),
        ).rejects.toMatchObject({ code });
      }
    });

    it('rethrows unexpected errors instead of hiding bugs', async () => {
      const { generate } = generator(() => new TypeError('bug'));
      await expect(
        closeCoverageGaps({ requirements: REQS, questions: [], generate }),
      ).rejects.toThrow(TypeError);
    });
  });

  it('produces a report that maps straight onto the Appendix A coverage object', async () => {
    const draftQs = [question('q1', ['r1'])];
    const { generate } = generator(() => [draft(['r2', 'r4', 'r5']), draft(['r3'], 'behavioural')]);
    const r = await closeCoverageGaps({ requirements: REQS, questions: draftQs, generate });
    expect(buildCoverage(r.report, r.passes)).toEqual({
      uncovered_requirement_ids: r.report.uncovered_requirement_ids,
      passes: r.passes,
    });
  });
});
