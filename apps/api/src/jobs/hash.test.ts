import { describe, expect, it } from 'vitest';
import { hashGenerationInput } from './hash.js';

const input = {
  jd: 'Senior Backend Engineer\nNode, Mongo',
  company_url: 'http://x.test/acme/',
  days: 5,
};

describe('hashGenerationInput', () => {
  it('is a stable sha256 hex digest', () => {
    expect(hashGenerationInput(input)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashGenerationInput(input)).toBe(hashGenerationInput({ ...input }));
  });

  it('ignores whitespace and line-ending differences in the description', () => {
    const noisy = { ...input, jd: '  Senior   Backend Engineer\r\n\r\nNode,   Mongo \n' };
    expect(hashGenerationInput(noisy)).toBe(hashGenerationInput(input));
  });

  it('normalises equivalent URLs (host case, trailing slash, fragment)', () => {
    const a = hashGenerationInput({ ...input, company_url: 'HTTP://X.test/acme' });
    const b = hashGenerationInput({ ...input, company_url: 'http://x.test/acme/#team' });
    expect(a).toBe(b);
    expect(a).toBe(hashGenerationInput(input));
  });

  it('keeps query strings significant', () => {
    expect(hashGenerationInput({ ...input, company_url: 'http://x.test/acme/?a=1' })).not.toBe(
      hashGenerationInput(input),
    );
  });

  it('changes when the description, company or days change', () => {
    const base = hashGenerationInput(input);
    expect(hashGenerationInput({ ...input, jd: input.jd + ' Kafka' })).not.toBe(base);
    expect(hashGenerationInput({ ...input, company_url: 'http://y.test/acme/' })).not.toBe(base);
    expect(hashGenerationInput({ ...input, days: 6 })).not.toBe(base);
  });

  it('is case sensitive for the description', () => {
    expect(hashGenerationInput({ ...input, jd: input.jd.toUpperCase() })).not.toBe(
      hashGenerationInput(input),
    );
  });
});
