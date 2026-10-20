import { afterEach, describe, expect, it } from 'vitest';
import {
  SNAPSHOT_MAX_DISCUSSION,
  SNAPSHOT_MAX_MENTIONS,
  SNAPSHOT_MAX_PAGES,
  SNAPSHOT_MENTION_MAX,
  SNAPSHOT_PAGE_TEXT_MAX,
  researchSnapshotSchema,
  type ResearchSnapshot,
} from '@trao/contracts';
import { buildResearchSnapshot } from './research-snapshot.js';
import { conventionalSite } from './research/test-support/sites.js';
import { runCase } from './run-case.js';
import {
  DETAILED_JD,
  PROCESS_TEXT,
  PROCESS_URL,
  makeResearch,
} from './stages/test-support/fixtures.js';
import {
  makeCaseHarness,
  startFixtureSite,
  type FixtureSite,
} from './test-support/case-harness.js';

type Available = Extract<ResearchSnapshot, { status: 'available' }>;
const available = (s: ResearchSnapshot): Available => {
  if (s.status !== 'available') throw new Error('expected an available snapshot');
  return s;
};

const sites: FixtureSite[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
});

describe('what is captured', () => {
  const research = makeResearch();
  const snap = available(buildResearchSnapshot(research));

  it('copies what the research stage observed, with its attribution', () => {
    expect(snap).toMatchObject({
      status: 'available',
      captured_at: research.researched_at,
      company_url: research.crawl.company_url,
      company_name: 'Acme Payments',
      crawl_status: 'ok',
    });
    expect(snap.pages.map((p) => p.url)).toEqual(research.crawl.pages.map((p) => p.url));
    const process = snap.pages.find((p) => p.url === PROCESS_URL)!;
    expect(process).toMatchObject({
      role: 'hiring-process',
      text: PROCESS_TEXT,
      fetched_at: '2026-02-03T04:05:06.000Z',
    });
    expect(process.interview_mentions).toEqual([
      'Next comes a take-home project that should take about four hours.',
      'The final stage is a system design interview.',
    ]);
    // the text is a verbatim copy of what was fetched, not a rewrite
    expect(research.crawl.pages.find((p) => p.url === PROCESS_URL)!.text).toBe(process.text);
    expect(snap.discussion).toMatchObject({ provider: 'hn-algolia', status: 'ok' });
    expect(snap.discussion.items).toEqual([
      {
        url: 'https://news.ycombinator.com/item?id=111',
        kind: 'comment',
        title: 'Ask HN: interview experiences',
        snippet: 'I interviewed at Acme Payments. The onsite had a system design round.',
      },
    ]);
  });

  it('keeps only the fields later stages read, and nothing personal or raw', () => {
    expect(Object.keys(snap.pages[0]!).sort()).toEqual(
      [
        'depth',
        'description',
        'fetched_at',
        'interview_mentions',
        'role',
        'text',
        'title',
        'url',
      ].sort(),
    );
    expect(Object.keys(snap.discussion.items[0]!).sort()).toEqual([
      'kind',
      'snippet',
      'title',
      'url',
    ]);
    const json = JSON.stringify(snap);
    expect(json).not.toContain('someone'); // the forum author
    expect(json).not.toContain('content_hash');
    expect(json).not.toContain('requested_url');
    expect(json).not.toContain('headings');
  });

  it('is valid against the schema the API checks it with', () => {
    expect(researchSnapshotSchema.safeParse(snap).success).toBe(true);
  });

  it('represents a missing company name and an empty discussion as they are, without inventing anything', () => {
    const bare = makeResearch({ company: { name: null, name_source: null, inferred: false } });
    const s = available(
      buildResearchSnapshot({
        ...bare,
        discussion: { ...bare.discussion, status: 'unavailable', items: [] },
      }),
    );
    expect(s.company_name).toBeNull();
    expect(s.discussion).toMatchObject({ status: 'unavailable', items: [] });
  });
});

describe('size limits', () => {
  const big = makeResearch();
  const template = big.crawl.pages[0]!;
  const manyPages = Array.from({ length: 30 }, (_, i) => ({
    ...template,
    url: `https://acme.test/p${i}`,
    text: 'word '.repeat(50_000),
    interview_mentions: Array.from({ length: 50 }, (_, j) => `mention ${j} ${'x'.repeat(2_000)}`),
    title: 't'.repeat(2_000),
    description: 'd'.repeat(5_000),
    depth: 99,
  }));
  const oversized = {
    ...big,
    crawl: { ...big.crawl, pages: manyPages },
    discussion: {
      ...big.discussion,
      items: Array.from({ length: 40 }, (_, i) => ({
        ...big.discussion.items[0]!,
        url: `https://news.ycombinator.com/item?id=${i}`,
        snippet: 's'.repeat(10_000),
        title: 't'.repeat(2_000),
      })),
    },
  };
  const snap = available(buildResearchSnapshot(oversized));

  it('caps pages, text, mentions, discussion and field lengths at the documented limits', () => {
    expect(snap.pages).toHaveLength(SNAPSHOT_MAX_PAGES);
    expect(snap.pages.every((p) => p.text.length <= SNAPSHOT_PAGE_TEXT_MAX)).toBe(true);
    expect(snap.pages[0]!.text.length).toBe(SNAPSHOT_PAGE_TEXT_MAX);
    expect(snap.pages.every((p) => p.interview_mentions.length <= SNAPSHOT_MAX_MENTIONS)).toBe(
      true,
    );
    expect(snap.pages[0]!.interview_mentions.every((m) => m.length <= SNAPSHOT_MENTION_MAX)).toBe(
      true,
    );
    expect(snap.pages[0]!.title.length).toBe(500);
    expect(snap.pages[0]!.description.length).toBe(1_000);
    expect(snap.pages[0]!.depth).toBe(20);
    expect(snap.discussion.items).toHaveLength(SNAPSHOT_MAX_DISCUSSION);
    expect(snap.discussion.items[0]!.snippet.length).toBe(2_000);
  });

  it('keeps the beginning of a long page (a prefix of the original), never a different text', () => {
    expect(manyPages[0]!.text.startsWith(snap.pages[0]!.text)).toBe(true);
  });

  it('stays small enough to store and return with every kit, even from a hostile crawl', () => {
    expect(JSON.stringify(snap).length).toBeLessThan(150_000);
  });

  it('still passes schema validation when everything was cut', () => {
    expect(researchSnapshotSchema.safeParse(snap).success).toBe(true);
  });

  it('shows the model-facing evidence in full: the generation stages never read past 3,000 characters', () => {
    expect(SNAPSHOT_PAGE_TEXT_MAX).toBeGreaterThanOrEqual(3_000);
  });
});

describe('runCase', () => {
  it('returns a snapshot of the research it actually ran, next to the kit', async () => {
    const s = await startFixtureSite(conventionalSite());
    sites.push(s);
    const { deps } = makeCaseHarness();
    const out = await runCase({ jd: DETAILED_JD, company_url: s.url('/'), days: 5 }, deps);
    const snap = available(out.researchSnapshot);
    expect(snap.pages.length).toBe(out.research.pagesFetched);
    expect(snap.pages.map((p) => p.url).sort()).toEqual([...out.kit.source.pages_used].sort());
    expect(snap.company_url).toBe(out.kit.source.company_url);
    expect(snap.captured_at).toBe(out.kit.source.researched_at);
    expect(snap.pages.some((p) => p.text.trim().length > 0)).toBe(true);
    expect(researchSnapshotSchema.safeParse(out.researchSnapshot).success).toBe(true);
  });
});
