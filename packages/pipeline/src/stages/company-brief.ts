import type { LlmClient } from '../llm/client.js';
import type { ResearchResult } from '../research/research.js';
import type { SourcePage } from '../research/types.js';
import { isGrounded } from './grounding.js';
import { clip, systemPrompt, untrustedBlock } from './prompt.js';
import { briefSchema } from './schemas.js';

const MAX_PAGES = 6;
const MAX_PAGE_CHARS = 3000;
const MIN_USABLE_TEXT = 40;
const MAX_OUTPUT_TOKENS = 4000;
const MAX_MENTIONS = 5;

export interface BriefEvidence {
  text: string;
  quote: string;
  source_url: string;
  /** When the cited page was retrieved. */
  fetched_at: string;
}

export interface CompanyBriefResult {
  /** The Appendix A company_brief. */
  brief: { summary: string; what_they_do: string; sources: string[] };
  /** The verified claims behind the brief: each has a verbatim quote from a page we fetched. */
  evidence: BriefEvidence[];
  /**
   * model-summary          prose written by the model, with at least one verified claim behind it
   * deterministic-fallback text taken from the company's own pages without a model
   * none                   nothing could be retrieved, and the brief says so
   */
  provenance: 'model-summary' | 'deterministic-fallback' | 'none';
  limitations: string[];
  dropped: { claims: number };
}

const ROLE = [
  'You write a short, factual company brief using ONLY the supplied pages from the company’s own website.',
  '',
  'Rules:',
  '- what_they_do: one to three sentences on what the company does and for whom.',
  '- summary: two to five sentences: what the company is, and, only if the sources say so, how it hires.',
  '- claims: up to 8 factual statements you relied on. For EACH give the exact source URL it came from',
  '  (copied from the "Source URL" line) and a short quote copied VERBATIM from that source.',
  '- Do not put URLs in what_they_do or summary. Do not use outside knowledge. Do not guess.',
  '- If the sources do not say something, leave it out. If they say little, write little.',
].join('\n');

const ROLE_RANK: Record<SourcePage['role'], number> = {
  home: 0,
  about: 1,
  'hiring-process': 2,
  hiring: 3,
  other: 4,
};

function usablePages(research: ResearchResult): SourcePage[] {
  return research.crawl.pages
    .filter((p) => p.text.trim().length >= MIN_USABLE_TEXT)
    .map((p, index) => ({ p, index }))
    .sort(
      (a, b) =>
        ROLE_RANK[a.p.role] - ROLE_RANK[b.p.role] || a.p.depth - b.p.depth || a.index - b.index,
    )
    .map(({ p }) => p)
    .slice(0, MAX_PAGES);
}

/** Removes any URL that is not one of the allowed sources. */
function scrubUrls(text: string, allowed: ReadonlySet<string>): string {
  return text
    .replace(/https?:\/\/[^\s)>\]"']+/gi, (url) => {
      const trimmed = url.replace(/[.,;:!?]+$/, '');
      return allowed.has(trimmed) ? url : '';
    })
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

function companyName(research: ResearchResult): string {
  return research.company.name ?? 'this company';
}

/**
 * A brief that needs no model: what the company's own page says about itself (its meta
 * description, or the opening of its text), or, with no pages, an explicit statement that nothing
 * could be retrieved. Used when the model is unavailable or its claims cannot be verified.
 */
export function deterministicBrief(research: ResearchResult, reason?: string): CompanyBriefResult {
  const pages = usablePages(research);
  const limitations: string[] = reason ? [reason] : [];
  const name = companyName(research);

  const source = pages[0];
  if (!source) {
    const why =
      research.crawl.status === 'ok' || research.crawl.status === 'partial'
        ? 'its website had no readable text'
        : research.crawl.status === 'blocked-by-robots'
          ? 'its robots.txt does not allow crawling'
          : research.crawl.status === 'rejected'
            ? 'the website address was not usable'
            : 'its website could not be retrieved';
    limitations.push(
      'No company information could be gathered, so the brief contains no company facts.',
    );
    return {
      brief: {
        summary: `No information about ${name} could be retrieved: ${why}. This brief therefore says nothing about what the company does.`,
        what_they_do: '',
        sources: [],
      },
      evidence: [],
      provenance: 'none',
      limitations,
      dropped: { claims: 0 },
    };
  }

  const own = source.description.trim() || clip(source.text.trim().split('\n')[0] ?? '', 300).text;
  return {
    brief: {
      summary: `According to the company’s own website: ${own}`,
      what_they_do: own,
      sources: [source.url],
    },
    evidence: [{ text: own, quote: own, source_url: source.url, fetched_at: source.fetched_at }],
    provenance: 'deterministic-fallback',
    limitations,
    dropped: { claims: 0 },
  };
}

/**
 * Stage 2: the company brief. One model call over pages the crawler actually fetched. The model
 * writes prose and lists the claims it relied on; application code keeps a claim only if its URL
 * is one of the fetched pages and its quote really appears on that page. URLs in the prose that
 * were not supplied are removed, and with no verified claim the prose is not trusted at all.
 */
export async function generateCompanyBrief(
  llm: LlmClient,
  research: ResearchResult,
): Promise<CompanyBriefResult> {
  const pages = usablePages(research);
  if (pages.length === 0) return deterministicBrief(research);

  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const allowed = new Set(byUrl.keys());

  const sections = pages.map((p, i) =>
    [
      `Source ${i + 1} URL: ${p.url}`,
      untrustedBlock(`page-${i + 1}`, clip(p.text, MAX_PAGE_CHARS).text),
    ].join('\n'),
  );

  const mentions = pages
    .flatMap((p) => p.interview_mentions.map((m) => ({ url: p.url, m })))
    .slice(0, MAX_MENTIONS);
  const hiring =
    mentions.length > 0
      ? [
          'Passages from the company’s pages about how it interviews (quoted, each with its source):',
          ...mentions.map(
            (x, i) =>
              `Hiring source ${i + 1} URL: ${x.url}\n${untrustedBlock(`hiring-${i + 1}`, x.m)}`,
          ),
        ].join('\n')
      : 'The company’s pages do not describe how the company hires. Do not describe the hiring process.';

  const out = await llm.generateObject({
    stage: 'company-brief',
    system: systemPrompt('company-brief', ROLE),
    prompt: [
      `Company: ${companyName(research)}`,
      '',
      'Sources from the company’s own website:',
      ...sections,
      '',
      hiring,
    ].join('\n'),
    schema: briefSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  const evidence: BriefEvidence[] = [];
  let dropped = 0;
  for (const claim of out.claims) {
    const page = byUrl.get(claim.source_url);
    if (!page || !isGrounded(claim.quote, page.text)) {
      dropped++;
      continue;
    }
    evidence.push({
      text: claim.text.trim(),
      quote: claim.quote.trim(),
      source_url: page.url,
      fetched_at: page.fetched_at,
    });
  }

  if (evidence.length === 0) {
    return deterministicBrief(
      research,
      'The model’s description of the company could not be verified against the fetched pages, so only the website’s own wording is used.',
    );
  }

  const limitations =
    dropped > 0
      ? [
          `${dropped} claim(s) from the model were not supported by the cited pages and were dropped.`,
        ]
      : [];
  return {
    brief: {
      what_they_do: scrubUrls(out.what_they_do, allowed),
      summary: scrubUrls(out.summary, allowed),
      sources: [...new Set(evidence.map((e) => e.source_url))],
    },
    evidence,
    provenance: 'model-summary',
    limitations,
    dropped: { claims: dropped },
  };
}
