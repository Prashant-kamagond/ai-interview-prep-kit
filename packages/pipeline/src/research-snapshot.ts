import {
  SNAPSHOT_MAX_DISCUSSION,
  SNAPSHOT_MAX_MENTIONS,
  SNAPSHOT_MAX_PAGES,
  SNAPSHOT_MENTION_MAX,
  SNAPSHOT_PAGE_TEXT_MAX,
  researchSnapshotSchema,
  type ResearchSnapshot,
} from '@trao/contracts';
import type { ResearchResult } from './research/research.js';

type Available = Extract<ResearchSnapshot, { status: 'available' }>;

const cut = (text: string, max: number) => (text.length <= max ? text : text.slice(0, max));

/**
 * Copies what a later regeneration needs out of a finished research stage, and nothing else.
 *
 * Kept, exactly as the crawler observed them: each page's address, title, description, role and
 * depth, the beginning of its readable text (as much as the generation stages ever show a model),
 * the interview sentences quoted from it and when it was fetched; the company name the research
 * settled on; and public discussion snippets with their addresses.
 *
 * Not kept: headings, link counts, content hashes, response headers, robots data, failures, the raw
 * HTML (the crawler never keeps it), and the authors, scores and dates of forum posts. The snapshot
 * is checked against the same schema the API validates it with before it is returned, so what gets
 * stored is always within the documented limits.
 */
export function buildResearchSnapshot(research: ResearchResult): ResearchSnapshot {
  const snapshot: Available = {
    status: 'available',
    captured_at: research.researched_at,
    company_url: research.crawl.company_url,
    company_name: research.company.name,
    crawl_status: research.crawl.status,
    pages: research.crawl.pages.slice(0, SNAPSHOT_MAX_PAGES).map((p) => ({
      url: p.url,
      title: cut(p.title, 500),
      description: cut(p.description, 1_000),
      role: p.role,
      depth: Math.min(Math.max(p.depth, 0), 20),
      text: cut(p.text, SNAPSHOT_PAGE_TEXT_MAX),
      interview_mentions: p.interview_mentions
        .slice(0, SNAPSHOT_MAX_MENTIONS)
        .map((m) => cut(m, SNAPSHOT_MENTION_MAX)),
      fetched_at: p.fetched_at,
    })),
    discussion: {
      provider: research.discussion.provider,
      status: research.discussion.status,
      retrieved_at: research.discussion.retrieved_at,
      items: research.discussion.items.slice(0, SNAPSHOT_MAX_DISCUSSION).map((i) => ({
        url: i.url,
        kind: i.kind,
        title: i.title === null ? null : cut(i.title, 500),
        snippet: cut(i.snippet, 2_000),
      })),
    },
  };
  return researchSnapshotSchema.parse(snapshot);
}
