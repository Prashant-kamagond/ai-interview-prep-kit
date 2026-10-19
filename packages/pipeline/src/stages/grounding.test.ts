import { describe, expect, it } from 'vitest';
import {
  groundedWords,
  inferPriority,
  isGrounded,
  positionInSource,
  textStaysCloseToQuote,
} from './grounding.js';

const JD = `Senior Backend Engineer — Remote (EU time zones)

About the role
We are building the payments platform that thousands of merchants rely on.

Requirements:
- 5+ years of professional experience with Node.js
- Strong knowledge of PostgreSQL & data modelling
- Experience mentoring junior engineers

Nice to have:
* Experience with Kafka or other event streaming
* Familiarity with Kubernetes

Bonus points if you have contributed to open source.
Experience with Rust is a plus.
`;

describe('isGrounded', () => {
  it('accepts a quote that appears in the source, ignoring case, punctuation and whitespace', () => {
    expect(isGrounded('5+ years of professional experience with Node.js', JD)).toBe(true);
    expect(isGrounded('5 YEARS of   professional experience with node js', JD)).toBe(true);
    expect(isGrounded('Strong knowledge of PostgreSQL & data modelling', JD)).toBe(true);
  });

  it('rejects text the source does not contain', () => {
    expect(isGrounded('Must hold a security clearance', JD)).toBe(false);
    expect(isGrounded('10+ years of professional experience with Node.js', JD)).toBe(false);
  });

  it('matches whole words only', () => {
    expect(isGrounded('experience with Node', JD)).toBe(true);
    expect(isGrounded('experience wit', JD)).toBe(false);
  });

  it('rejects empty or trivial quotes', () => {
    for (const q of ['', '   ', '...', 'a'])
      expect(isGrounded(q, JD), JSON.stringify(q)).toBe(false);
  });

  it('allows a short but real quote', () => {
    expect(isGrounded('Kafka', JD)).toBe(true);
    expect(isGrounded('Rust', JD)).toBe(true);
  });
});

describe('positionInSource', () => {
  it('orders quotes by where they appear', () => {
    const a = positionInSource('Strong knowledge of PostgreSQL', JD);
    const b = positionInSource('Familiarity with Kubernetes', JD);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
  });

  it('returns -1 when the quote is not there', () => {
    expect(positionInSource('security clearance', JD)).toBe(-1);
  });
});

describe('groundedWords', () => {
  it('keeps a value only if every word comes from the source', () => {
    expect(groundedWords('Senior Backend Engineer', JD)).toBe('Senior Backend Engineer');
    expect(groundedWords('Remote', JD)).toBe('Remote');
    expect(groundedWords('Principal Architect', JD)).toBe('');
    expect(groundedWords('', JD)).toBe('');
  });
});

describe('textStaysCloseToQuote', () => {
  it('accepts a tidy restatement and rejects drift', () => {
    const quote = '5+ years of professional experience with Node.js';
    expect(textStaysCloseToQuote('5+ years with Node.js', quote)).toBe(true);
    expect(textStaysCloseToQuote('Node.js experience', quote)).toBe(true);
    expect(textStaysCloseToQuote('Expert in Go, Rust and Kubernetes', quote)).toBe(false);
  });
});

describe('inferPriority', () => {
  const p = (quote: string) => inferPriority(quote, JD);

  it('reads the section heading above a requirement', () => {
    expect(p('5+ years of professional experience with Node.js')?.priority).toBe('must');
    expect(p('Strong knowledge of PostgreSQL & data modelling')?.priority).toBe('must');
    expect(p('Experience with Kafka or other event streaming')?.priority).toBe('nice');
    expect(p('Familiarity with Kubernetes')?.priority).toBe('nice');
  });

  it('reads inline wording on the same line', () => {
    expect(p('Experience with Rust is a plus')?.priority).toBe('nice');
    expect(p('Bonus points if you have contributed to open source')?.priority).toBe('nice');
  });

  it('lets inline wording beat the heading', () => {
    const jd = 'Requirements:\n- Go\n- Experience with Kafka is a plus\n';
    expect(inferPriority('Experience with Kafka is a plus', jd)?.priority).toBe('nice');
    expect(inferPriority('Go', jd)?.priority).toBe('must');
  });

  it('treats explicit "required" and "must" wording as must-have', () => {
    const jd =
      'What you will do\n- Build things\nSkills\n- Python is required\n- Must be able to travel\n';
    expect(inferPriority('Python is required', jd)?.priority).toBe('must');
    expect(inferPriority('Must be able to travel', jd)?.priority).toBe('must');
  });

  it('handles preferred / desirable / ideally / good to have headings', () => {
    for (const heading of [
      'Preferred qualifications',
      'Desirable',
      'Good to have',
      'Ideally you also have',
      'Bonus',
    ]) {
      const jd = `${heading}:\n- Experience with Terraform\n`;
      expect(inferPriority('Experience with Terraform', jd)?.priority, heading).toBe('nice');
    }
  });

  it('handles must-have style headings', () => {
    for (const heading of [
      'Must have',
      'Minimum qualifications',
      "What you'll need",
      'Required skills',
      'Basic qualifications',
    ]) {
      const jd = `${heading}:\n- Experience with Terraform\n`;
      expect(inferPriority('Experience with Terraform', jd)?.priority, heading).toBe('must');
    }
  });

  it('returns null when there is no cue, leaving the model judgement alone', () => {
    const jd = 'About the role\nWe use Terraform for infrastructure and love it.\n';
    expect(inferPriority('We use Terraform for infrastructure', jd)).toBeNull();
    expect(inferPriority('not in the text', JD)).toBeNull();
  });

  it('gives a reason that can be shown to a person', () => {
    expect(p('Familiarity with Kubernetes')?.reason).toMatch(/nice to have/i);
  });

  it('does not let a neutral nearer heading inherit an earlier one', () => {
    const jd = 'Nice to have:\n- Kafka\nAbout us\nWe also use Terraform.\n';
    expect(inferPriority('We also use Terraform', jd)).toBeNull();
  });
});
