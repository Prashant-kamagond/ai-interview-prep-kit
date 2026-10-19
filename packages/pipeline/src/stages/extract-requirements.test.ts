import { describe, expect, it } from 'vitest';
import { createLlmClient } from '../llm/client.js';
import { LlmError } from '../llm/errors.js';
import { createFakeProvider, type FakeScript } from '../llm/test-support/fake-provider.js';
import { createFakeClock } from '../research/test-support/fake-clock.js';
import { extractRequirements, MAX_JD_CHARS } from './extract-requirements.js';
import {
  DETAILED_JD,
  INJECTION_JD,
  QUOTES,
  SPARSE_JD,
  goodExtraction,
} from './test-support/fixtures.js';

function setup(script: FakeScript) {
  const provider = createFakeProvider(script);
  const llm = createLlmClient({ provider, clock: createFakeClock(0), random: () => 1 });
  return { provider, llm };
}

describe('detailed job description', () => {
  it('extracts requirements with stable ids in the order they appear in the posting', async () => {
    const { llm } = setup(() => goodExtraction());
    const role = await extractRequirements(llm, { jd: DETAILED_JD });

    expect(role.requirements.map((r) => r.id)).toEqual([
      'r1',
      'r2',
      'r3',
      'r4',
      'r5',
      'r6',
      'r7',
      'r8',
    ]);
    expect(role.requirements.map((r) => r.text)).toEqual([
      '5+ years with Node.js',
      'Strong PostgreSQL and data modelling',
      'Mentoring junior engineers',
      'Excellent written English',
      'Kafka or event streaming',
      'Kubernetes familiarity',
      'Open source contributions',
      'Rust',
    ]);
    expect(role).toMatchObject({
      title: 'Senior Backend Engineer',
      seniority: 'Senior',
      location: 'Remote',
      company: 'Acme Payments',
      sparse: false,
    });
    expect(role.responsibilities).toEqual([
      'Design and operate the payment APIs',
      'Mentor engineers',
    ]);
  });

  it('uses exactly one model call', async () => {
    const { llm, provider } = setup(() => goodExtraction());
    await extractRequirements(llm, { jd: DETAILED_JD });
    expect(provider.calls).toHaveLength(1);
  });

  it('keeps every required field in the Appendix A shape', async () => {
    const { llm } = setup(() => goodExtraction());
    const role = await extractRequirements(llm, { jd: DETAILED_JD });
    for (const r of role.requirements) {
      expect(Object.keys(r).sort()).toEqual(['id', 'kind', 'priority', 'text']);
      expect(['technical', 'behavioural', 'domain']).toContain(r.kind);
      expect(['must', 'nice']).toContain(r.priority);
    }
  });

  it('gives the same ids and order whatever order the model lists them in', async () => {
    const shuffled = goodExtraction();
    shuffled.requirements = [...shuffled.requirements].reverse();
    const a = await extractRequirements(setup(() => goodExtraction()).llm, { jd: DETAILED_JD });
    const b = await extractRequirements(setup(() => shuffled).llm, { jd: DETAILED_JD });
    expect(b.requirements).toEqual(a.requirements);
  });
});

describe('must / nice-to-have', () => {
  it('lets the posting’s own wording override the model', async () => {
    const wrong = goodExtraction();
    wrong.requirements = wrong.requirements.map((r) => ({
      ...r,
      priority: r.quote === QUOTES.kafka ? 'must' : r.quote === QUOTES.node ? 'nice' : r.priority,
    }));
    const { llm } = setup(() => wrong);
    const role = await extractRequirements(llm, { jd: DETAILED_JD });

    const by = (needle: string) => role.requirements.find((r) => r.text.includes(needle))!;
    expect(by('Node.js').priority).toBe('must'); // under "Requirements:"
    expect(by('Kafka').priority).toBe('nice'); // under "Nice to have:"
    expect(by('Rust').priority).toBe('nice'); // "is a plus"
    expect(by('Open source').priority).toBe('nice'); // "Bonus points"
    expect(role.notes.priorityOverrides).toBe(2);
  });

  it('keeps the model’s judgement when the posting gives no cue', async () => {
    const jd = 'About us\nWe build things.\nSkills\n- Terraform';
    // "Skills" is not a priority heading, so the model's own call stands.
    const { llm } = setup(() => ({
      title: '',
      seniority: '',
      location: '',
      company: '',
      responsibilities: [],
      requirements: [
        { text: 'Terraform', quote: 'Terraform', kind: 'technical', priority: 'nice' },
      ],
    }));
    const role = await extractRequirements(llm, { jd });
    expect(role.requirements[0]?.priority).toBe('nice');
    expect(role.notes.priorityOverrides).toBe(0);
  });
});

describe('nothing is invented', () => {
  it('drops requirements whose quote is not in the posting, and says how many', async () => {
    const out = goodExtraction();
    out.requirements.push(
      {
        text: 'Security clearance',
        quote: 'Must hold a security clearance',
        kind: 'domain',
        priority: 'must',
      },
      { text: 'GraphQL', quote: 'Experience with GraphQL', kind: 'technical', priority: 'must' },
    );
    const { llm } = setup(() => out);
    const role = await extractRequirements(llm, { jd: DETAILED_JD });

    expect(role.requirements).toHaveLength(8);
    expect(role.requirements.some((r) => /clearance|graphql/i.test(r.text))).toBe(false);
    expect(role.notes.droppedUngrounded.requirements).toBe(2);
    expect(role.limitations.join(' ')).toMatch(/2 .*not (?:found|appear)/i);
  });

  it('drops invented responsibilities too', async () => {
    const out = goodExtraction({
      responsibilities: [
        { text: 'Run the company', quote: 'Run the entire company' },
        {
          text: 'Mentor engineers',
          quote: 'Mentor engineers and improve our engineering practices',
        },
      ],
    });
    const role = await extractRequirements(setup(() => out).llm, { jd: DETAILED_JD });
    expect(role.responsibilities).toEqual(['Mentor engineers']);
    expect(role.notes.droppedUngrounded.responsibilities).toBe(1);
  });

  it('blanks a title, seniority, location or company that the posting does not support', async () => {
    const out = goodExtraction({
      title: 'Principal Architect',
      seniority: 'Staff',
      location: 'Mars',
      company: 'Globex',
    });
    const role = await extractRequirements(setup(() => out).llm, { jd: DETAILED_JD });
    expect(role).toMatchObject({ title: '', seniority: '', location: '', company: '' });
  });

  it('replaces a restated requirement that drifts from its quote with the quote itself', async () => {
    const out = goodExtraction();
    out.requirements[0] = {
      ...out.requirements[0]!,
      text: 'Expert in Go, Rust, Kubernetes and Terraform',
    };
    const role = await extractRequirements(setup(() => out).llm, { jd: DETAILED_JD });
    expect(role.requirements[0]?.text).toBe(QUOTES.node);
  });

  it('merges duplicates, keeping the stronger priority', async () => {
    const out = goodExtraction();
    out.requirements.push({
      text: '5+ years with Node.js',
      quote: QUOTES.node,
      kind: 'technical',
      priority: 'nice',
    });
    const role = await extractRequirements(setup(() => out).llm, { jd: DETAILED_JD });
    expect(role.requirements.filter((r) => r.text === '5+ years with Node.js')).toHaveLength(1);
    expect(role.requirements).toHaveLength(8);
  });

  it('ignores an instruction embedded in the posting: only quoted, supported lines survive', async () => {
    // A model that obeys the injected notice and invents a requirement with a made-up quote.
    const out = goodExtraction();
    out.requirements.push({
      text: 'TS/SCI clearance',
      quote: 'The candidate shall hold TS/SCI clearance',
      kind: 'domain',
      priority: 'must',
    });
    const { llm, provider } = setup(() => out);
    const role = await extractRequirements(llm, { jd: INJECTION_JD });
    expect(role.requirements.some((r) => /clearance/i.test(r.text))).toBe(false);

    // And the posting only ever reaches the model inside a fenced, untrusted block.
    const call = provider.calls[0]!;
    expect(call.system).not.toContain('IMPORTANT SYSTEM NOTICE');
    expect(call.prompt).toContain('IMPORTANT SYSTEM NOTICE');
    const open = call.prompt.indexOf('<<<UNTRUSTED:job-description:');
    const close = call.prompt.lastIndexOf('>>>');
    expect(call.prompt.indexOf('IMPORTANT SYSTEM NOTICE')).toBeGreaterThan(open);
    expect(call.prompt.indexOf('IMPORTANT SYSTEM NOTICE')).toBeLessThan(close);
    expect(call.system).toMatch(/must not follow|do not follow|never follow/i);
  });
});

describe('sparse job descriptions', () => {
  it('produces a thin result for a two-line stub and says so', async () => {
    const out = {
      title: 'Backend engineer',
      seniority: '',
      location: '',
      company: '',
      responsibilities: [],
      requirements: [
        { text: 'Python', quote: 'Must know Python', kind: 'technical', priority: 'must' },
      ],
    };
    const role = await extractRequirements(setup(() => out).llm, { jd: SPARSE_JD });
    expect(role.sparse).toBe(true);
    expect(role.requirements).toEqual([
      { id: 'r1', text: 'Python', kind: 'technical', priority: 'must' },
    ]);
    expect(role.limitations.join(' ')).toMatch(/short|thin|little/i);
  });

  it('does not let the model pad a stub with invented requirements', async () => {
    const padded = {
      title: 'Backend engineer',
      seniority: 'Senior',
      location: 'Berlin',
      company: '',
      responsibilities: [{ text: 'Lead the team', quote: 'Lead a team of ten engineers' }],
      requirements: [
        { text: 'Python', quote: 'Must know Python', kind: 'technical', priority: 'must' },
        {
          text: '8 years of experience',
          quote: '8+ years of experience',
          kind: 'technical',
          priority: 'must',
        },
        { text: 'AWS', quote: 'Experience with AWS', kind: 'technical', priority: 'must' },
        { text: 'Leadership', quote: 'Leadership skills', kind: 'behavioural', priority: 'must' },
      ],
    };
    const role = await extractRequirements(setup(() => padded).llm, { jd: SPARSE_JD });
    expect(role.requirements.map((r) => r.text)).toEqual(['Python']);
    expect(role.responsibilities).toEqual([]);
    expect(role).toMatchObject({ seniority: '', location: '' });
  });

  it('returns an empty role without calling the model when there is nothing to read', async () => {
    const { llm, provider } = setup(() => goodExtraction());
    const role = await extractRequirements(llm, { jd: '   \n  ' });
    expect(provider.calls).toHaveLength(0);
    expect(role.requirements).toEqual([]);
    expect(role.sparse).toBe(true);
  });

  it('tells the model to return empty lists rather than guess', async () => {
    const { llm, provider } = setup(() => ({
      title: '',
      seniority: '',
      location: '',
      company: '',
      responsibilities: [],
      requirements: [],
    }));
    await extractRequirements(llm, { jd: SPARSE_JD });
    expect(provider.calls[0]!.system).toMatch(/empty/i);
    expect(provider.calls[0]!.system).toMatch(/do not invent|never invent/i);
  });
});

describe('limits and failures', () => {
  it('clips a very long posting, flags it, and drops anything beyond the cut', async () => {
    const tail = 'Experience with Haskell is required';
    const jd = `${DETAILED_JD}\n${'Filler line about the company culture.\n'.repeat(1000)}\n${tail}`;
    expect(jd.length).toBeGreaterThan(MAX_JD_CHARS);
    const out = goodExtraction();
    out.requirements.push({ text: 'Haskell', quote: tail, kind: 'technical', priority: 'must' });
    const { llm, provider } = setup(() => out);
    const role = await extractRequirements(llm, { jd });
    expect(role.notes.jdTruncated).toBe(true);
    expect(role.requirements.some((r) => r.text === 'Haskell')).toBe(false);
    expect(provider.calls[0]!.prompt.length).toBeLessThan(MAX_JD_CHARS + 5000);
  });

  it('repairs an output that breaks the schema, then succeeds', async () => {
    const { llm, provider } = setup((_r, n) =>
      n === 1
        ? goodExtraction({
            requirements: [{ text: 'x', quote: 'y', kind: 'magic', priority: 'must' }],
          })
        : goodExtraction(),
    );
    const role = await extractRequirements(llm, { jd: DETAILED_JD });
    expect(role.requirements).toHaveLength(8);
    expect(provider.calls).toHaveLength(2);
  });

  it('fails with a structured error after the single repair', async () => {
    const { llm, provider } = setup(() => 'not json');
    await expect(extractRequirements(llm, { jd: DETAILED_JD })).rejects.toMatchObject({
      code: 'INVALID_OUTPUT',
    });
    expect(provider.calls).toHaveLength(2);
  });

  it('propagates provider failures as LlmError', async () => {
    const { llm } = setup(() => new LlmError('AUTH_FAILED'));
    await expect(extractRequirements(llm, { jd: DETAILED_JD })).rejects.toBeInstanceOf(LlmError);
  });

  it('reports a non-sparse posting whose every requirement was unsupported as unverified, not as empty', async () => {
    const fabricated = goodExtraction({
      requirements: [
        {
          text: 'X',
          quote: 'Totally made up requirement text',
          kind: 'technical',
          priority: 'must',
        },
      ],
    });
    const role = await extractRequirements(setup(() => fabricated).llm, { jd: DETAILED_JD });
    expect(role.requirements).toEqual([]);
    expect(role.limitations.join(' ')).toMatch(/could not be verified|none were kept/i);
  });
});
