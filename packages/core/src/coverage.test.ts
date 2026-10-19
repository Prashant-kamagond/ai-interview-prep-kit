import { describe, expect, it } from 'vitest';
import { buildCoverage, checkCoverage } from './coverage.js';
import { question, req } from './fixtures.js';

describe('checkCoverage', () => {
  it('handles no requirements and no questions', () => {
    const r = checkCoverage([], []);
    expect(r.covered_requirement_ids).toEqual([]);
    expect(r.uncovered_requirement_ids).toEqual([]);
    expect(r.uncovered_must_ids).toEqual([]);
    expect(r.unknown_references).toEqual([]);
  });

  it('reports every requirement as uncovered when there are no questions (sparse kit)', () => {
    const r = checkCoverage([req('r1'), req('r2', 'nice')], []);
    expect(r.uncovered_requirement_ids).toEqual(['r1', 'r2']);
    expect(r.uncovered_must_ids).toEqual(['r1']);
  });

  it('reports nothing uncovered when fully covered, including by one multi-requirement question', () => {
    const r = checkCoverage([req('r1'), req('r2')], [question('q1', ['r1', 'r2'])]);
    expect(r.covered_requirement_ids).toEqual(['r1', 'r2']);
    expect(r.uncovered_requirement_ids).toEqual([]);
  });

  it('separates uncovered must-haves from uncovered nice-to-haves', () => {
    const r = checkCoverage(
      [req('r1'), req('r2', 'nice'), req('r3'), req('r4', 'nice')],
      [question('q1', ['r1'])],
    );
    expect(r.uncovered_requirement_ids).toEqual(['r2', 'r3', 'r4']);
    expect(r.uncovered_must_ids).toEqual(['r3']);
  });

  it('orders results by requirement order, independent of question order', () => {
    const reqs = [req('r3'), req('r1'), req('r2')];
    const a = checkCoverage(reqs, [question('q1', ['r2']), question('q2', ['r1'])]);
    const b = checkCoverage(reqs, [question('q2', ['r1']), question('q1', ['r2'])]);
    expect(a).toEqual(b);
    expect(a.uncovered_requirement_ids).toEqual(['r3']);
    expect(a.covered_requirement_ids).toEqual(['r1', 'r2']);
  });

  it('does not count unknown references as coverage and reports them', () => {
    const r = checkCoverage([req('r1')], [question('q1', ['r9']), question('q2', ['r1', 'r8'])]);
    expect(r.uncovered_requirement_ids).toEqual([]);
    expect(r.unknown_references).toEqual([
      { question_id: 'q1', requirement_id: 'r9' },
      { question_id: 'q2', requirement_id: 'r8' },
    ]);
    const only = checkCoverage([req('r1')], [question('q1', ['r9'])]);
    expect(only.uncovered_requirement_ids).toEqual(['r1']);
  });

  it('ignores questions with no requirement ids', () => {
    expect(checkCoverage([req('r1')], [question('q1', [])]).uncovered_requirement_ids).toEqual([
      'r1',
    ]);
  });

  it('lists a duplicated requirement id once', () => {
    expect(checkCoverage([req('r1'), req('r1')], []).uncovered_requirement_ids).toEqual(['r1']);
  });

  it('does not mutate its inputs and is repeatable', () => {
    const reqs = Object.freeze([Object.freeze(req('r1'))]);
    const qs = Object.freeze([Object.freeze(question('q1', ['r1']))]);
    expect(checkCoverage(reqs, qs)).toEqual(checkCoverage(reqs, qs));
  });
});

describe('buildCoverage', () => {
  it('produces the Appendix A coverage object', () => {
    const report = checkCoverage([req('r1'), req('r2')], [question('q1', ['r1'])]);
    expect(buildCoverage(report, 2)).toEqual({ uncovered_requirement_ids: ['r2'], passes: 2 });
  });
});
