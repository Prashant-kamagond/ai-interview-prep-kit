import { describe, expect, it } from 'vitest';
import { ContentDeduper, fingerprint, similarity } from './dedupe.js';

const para = (n: number) =>
  Array.from({ length: n }, (_, i) => `word${i % 97} signal${i % 31} rocket${i % 13}`).join(' ');

describe('fingerprint / similarity', () => {
  it('treats identical text as identical, ignoring case, punctuation and whitespace', () => {
    const a = fingerprint('Acme builds   rockets. We LOVE orbit!');
    const b = fingerprint('acme builds rockets we love orbit');
    expect(a.hash).toBe(b.hash);
    expect(similarity(a, b)).toBe(1);
  });

  it('scores unrelated text as dissimilar', () => {
    expect(
      similarity(
        fingerprint(para(200)),
        fingerprint('completely different content about cooking pasta and sauces '.repeat(20)),
      ),
    ).toBeLessThan(0.2);
  });

  it('scores a long page with a tiny change as nearly identical', () => {
    const base = para(400);
    expect(
      similarity(fingerprint(base), fingerprint(`${base} one extra sentence here`)),
    ).toBeGreaterThan(0.95);
  });
});

describe('ContentDeduper', () => {
  it('flags exact and near duplicates and reports which page they duplicate', () => {
    const d = new ContentDeduper(0.9);
    const base = para(400);
    expect(d.check('https://a.test/1', base)).toBeNull();
    expect(d.check('https://a.test/2', base)).toBe('https://a.test/1');
    expect(d.check('https://a.test/3', `${base} tiny footer difference`)).toBe('https://a.test/1');
    expect(
      d.check(
        'https://a.test/4',
        'A genuinely different page about something else entirely. '.repeat(30),
      ),
    ).toBeNull();
  });

  it('only compares short pages exactly (near-duplicate maths is meaningless for a few words)', () => {
    const d = new ContentDeduper(0.9);
    expect(d.check('https://a.test/1', 'Contact us')).toBeNull();
    expect(d.check('https://a.test/2', 'Contact us today')).toBeNull();
    expect(d.check('https://a.test/3', 'contact US')).toBe('https://a.test/1');
  });

  it('never treats empty text as a duplicate of other empty text', () => {
    const d = new ContentDeduper(0.9);
    expect(d.check('https://a.test/1', '')).toBeNull();
    expect(d.check('https://a.test/2', '  ')).toBeNull();
  });
});
