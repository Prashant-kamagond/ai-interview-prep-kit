import { describe, expect, it } from 'vitest';
import { makeKit } from '../../test/kit';
import { buildKitView, webHref } from './view';

describe('buildKitView', () => {
  const view = buildKitView(makeKit());

  it('splits requirements into must-have and nice-to-have, in kit order', () => {
    expect(view.mustHave.map((r) => r.id)).toEqual(['r1', 'r2', 'r4']);
    expect(view.niceToHave.map((r) => r.id)).toEqual(['r3']);
  });

  it('groups questions by category in a fixed order, skipping empty categories', () => {
    expect(view.groups.map((g) => g.category)).toEqual([
      'technical',
      'behavioural',
      'system-design',
      'company-fit',
    ]);
    expect(view.groups[0]?.label).toBe('Technical');
    const kit = makeKit();
    const only = buildKitView({
      ...kit,
      questions: kit.questions.filter((q) => q.category === 'behavioural'),
    });
    expect(only.groups.map((g) => g.category)).toEqual(['behavioural']);
  });

  it('resolves requirement references and keeps an unresolved one visible as null', () => {
    const q3 = view.groups.find((g) => g.category === 'system-design')!.questions[0]!;
    expect(q3.references.map((r) => r.requirement?.text)).toEqual([
      'Build REST APIs in Node.js',
      'Experience with payments',
    ]);
    const kit = makeKit();
    const broken = buildKitView({
      ...kit,
      questions: [{ ...kit.questions[0]!, requirement_ids: ['nope'] }],
    });
    expect(broken.groups[0]?.questions[0]?.references).toEqual([{ id: 'nope', requirement: null }]);
  });

  it('orders schedule days by day number and resolves their questions', () => {
    expect(view.days.map((d) => d.day)).toEqual([1, 2, 3]);
    expect(view.days[1]?.questions.map((q) => q.id)).toEqual(['q3', 'q2']);
    expect(view.days[2]?.questions).toEqual([]);
    expect(view.totalMinutes).toBe(180);
  });

  it('keeps a scheduled question the kit does not contain, marked as missing', () => {
    const kit = makeKit();
    const v = buildKitView({
      ...kit,
      schedule: {
        ...kit.schedule,
        days: [{ day: 1, focus: 'x', question_ids: ['ghost'], minutes: 5 }],
      },
    });
    expect(v.days[0]?.questions).toEqual([{ id: 'ghost', question: null }]);
  });

  it('reports coverage exactly as the kit states it', () => {
    expect(view.uncovered.map((u) => u.id)).toEqual(['r4']);
    expect(view.uncovered[0]?.requirement?.priority).toBe('must');
    expect(view.coveredCount).toBe(3);
  });

  it('does not mutate the kit it was given', () => {
    const kit = makeKit();
    const before = JSON.stringify(kit);
    buildKitView(kit);
    expect(JSON.stringify(kit)).toBe(before);
  });
});

describe('webHref', () => {
  it('returns web addresses only', () => {
    expect(webHref('https://acme.example/careers')).toBe('https://acme.example/careers');
    expect(webHref(' http://a.test ')).toBe('http://a.test/');
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://a.test',
      'not a url',
      '',
      '//a.test',
    ]) {
      expect(webHref(bad)).toBeNull();
    }
  });
});
