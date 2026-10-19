import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { firstPhrase, hasPhrase, normalizeWords } from '../text-match.js';

type Node = DefaultTreeAdapterMap['node'];

const MAX_COMPANY_CHARS = 60;
const SNIPPET_RADIUS = 140;

// Phrases that are about being interviewed for a job on their own. "hiring" alone is excluded on
// purpose: it matches every "Who is hiring?" job post, which is not discussion of how a company
// interviews.
const STRONG_TERMS = [
  'interview process',
  'interview loop',
  'interview round',
  'interview rounds',
  'hiring process',
  'interviewed at',
  'interviewed for',
  'interviewing at',
  'interviewing for',
  'take home',
  'onsite',
  'on site',
  'phone screen',
  'coding challenge',
  'system design',
  'technical screen',
  'recruiter',
  'whiteboard',
];

// "Interview" by itself is ambiguous ("user interviews", "an interview with the founder"), so it
// only counts when the post also uses hiring vocabulary or a strong phrase.
const WEAK_TERMS = ['interview', 'interviews', 'interviewed', 'interviewing'];
// Deliberately specific: "role" and "position" are everywhere ("our role in the market").
const HIRING_CONTEXT = new Set([
  'job',
  'jobs',
  'hire',
  'hired',
  'hiring',
  'candidate',
  'candidates',
  'applied',
  'applying',
  'application',
  'resume',
  'offer',
  'offered',
  'rejected',
  'rejection',
  'salary',
  'compensation',
  'onsite',
]);

/** How many words either side of a bare "interview" are searched for hiring vocabulary. */
const CONTEXT_WINDOW = 15;

// The monthly "Who is hiring?" / "Who wants to be hired?" threads hold job ads and job-seeker
// posts. Those are not discussion of how a company interviews, so they never count.
const JOB_BOARD_THREADS = [
  'who is hiring',
  'who wants to be hired',
  'freelancer seeking freelancer',
];

const INTERVIEW_TERMS = [...STRONG_TERMS, ...WEAK_TERMS];

/** Largest gap, in words, between the company name and the interview talk in a post's own text. */
const MAX_WORD_DISTANCE = 40;

function phrasePositions(words: readonly string[], phrase: string): number[] {
  const parts = phrase.split(' ');
  const positions: number[] = [];
  for (let i = 0; i + parts.length <= words.length; i++) {
    if (parts.every((part, k) => words[i + k] === part)) positions.push(i);
  }
  return positions;
}

const BLOCK_TAGS = new Set(['p', 'br', 'div', 'li', 'pre', 'blockquote', 'ul', 'ol']);
const DROP_TAGS = new Set(['script', 'style', 'template', 'noscript']);

/** Converts the HTML fragments HN returns (entities, <p>, <i>, <a>, <pre>) to plain text. */
export function htmlToText(html: string): string {
  if (html === '') return '';
  let fragment: Node;
  try {
    fragment = parseFragment(html);
  } catch {
    return '';
  }
  const parts: string[] = [];
  const stack: Node[] = [fragment];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.nodeName === '#text') {
      parts.push((node as DefaultTreeAdapterMap['textNode']).value);
      continue;
    }
    if ('tagName' in node && DROP_TAGS.has(node.tagName)) continue;
    const isBlock = 'tagName' in node && BLOCK_TAGS.has(node.tagName);
    if (isBlock) parts.push(' ');
    const children = 'childNodes' in node ? node.childNodes : [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    if (isBlock) stack.push({ nodeName: '#text', value: ' ' } as Node);
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/** Drops control characters; tab, newline and carriage return stay (they become spaces later). */
function stripControlCharacters(text: string): string {
  return [...text]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return (code >= 32 && code !== 127) || code === 9 || code === 10 || code === 13;
    })
    .join('');
}

/**
 * Makes a company name safe to put inside a quoted search phrase: control characters, quotes,
 * brackets and other query-syntax characters are removed, words that start with "-" lose it,
 * whitespace is collapsed and the length is bounded.
 */
export function sanitizeCompanyName(raw: string): string {
  return stripControlCharacters(raw)
    .replace(/["“”()[\]{}<>\\*~^!|:]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/(^| )-+/g, '$1')
    .trim()
    .slice(0, MAX_COMPANY_CHARS)
    .trim();
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export interface Assessment {
  relevant: boolean;
  matchedTerms: string[];
  /** The plain text the snippet was cut from. */
  text: string;
  snippet: string;
}

function makeSnippet(text: string): string {
  const pattern = new RegExp(
    INTERVIEW_TERMS.map((t) => t.split(' ').join('[\\s-]+')).join('|'),
    'i',
  );
  const match = pattern.exec(text);
  const center = match ? match.index : 0;

  let start = Math.max(0, center - SNIPPET_RADIUS);
  let end = Math.min(text.length, center + SNIPPET_RADIUS);
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space !== -1 && space < center) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > center) end = space;
  }
  return `${start > 0 ? '… ' : ''}${text.slice(start, end).trim()}${end < text.length ? ' …' : ''}`;
}

/** Decides whether a search hit really discusses interviewing at `company`, and extracts a snippet. */
export function assessHit(hit: Record<string, unknown>, company: string): Assessment {
  const comment = htmlToText(str(hit.comment_text));
  const storyText = htmlToText(str(hit.story_text));
  const title = str(hit.title).trim();
  const storyTitle = str(hit.story_title).trim();
  // The post's own words. The parent story's title (for a comment) may supply the company name,
  // so replies inside a "<Company> interview experiences" thread count, but it can never supply
  // the interview vocabulary: a comment must itself talk about interviewing.
  const own = [comment, storyText, title].filter((t) => t !== '');

  const ownNormalized = normalizeWords(own.join(' . '));
  const ownWords = ownNormalized === '' ? [] : ownNormalized.split(' ');
  const companyPhrase = normalizeWords(company);

  const strong = STRONG_TERMS.filter((t) => hasPhrase(ownNormalized, t));
  // A bare "interview" counts if the post also has a strong phrase, or hiring vocabulary within a
  // few words of it. ("We run user interviews every week" has neither.)
  const nearHiringWords = (at: number) =>
    ownWords
      .slice(Math.max(0, at - CONTEXT_WINDOW), at + CONTEXT_WINDOW + 1)
      .some((w) => HIRING_CONTEXT.has(w));
  const weak = WEAK_TERMS.filter(
    (t) =>
      hasPhrase(ownNormalized, t) &&
      (strong.length > 0 || phrasePositions(ownWords, t).some(nearHiringWords)),
  );
  const matchedTerms = INTERVIEW_TERMS.filter((t) => strong.includes(t) || weak.includes(t));

  // The company counts if the thread title names it (a reply inside "<Company> interview
  // experiences"), or if the post names it close to the interview talk.
  const inParentTitle =
    companyPhrase !== '' && hasPhrase(normalizeWords(storyTitle), companyPhrase);
  let mentionsCompany = inParentTitle;
  if (!mentionsCompany && companyPhrase !== '' && matchedTerms.length > 0) {
    const companyAt = phrasePositions(ownWords, companyPhrase);
    const termsAt = matchedTerms.flatMap((t) => phrasePositions(ownWords, t));
    mentionsCompany = companyAt.some((c) =>
      termsAt.some((t) => Math.abs(c - t) <= MAX_WORD_DISTANCE),
    );
  }
  const inJobBoardThread = JOB_BOARD_THREADS.some((t) => hasPhrase(normalizeWords(storyTitle), t));
  const relevant = mentionsCompany && matchedTerms.length > 0 && !inJobBoardThread;

  const source =
    own.find((t) => firstPhrase(normalizeWords(t), INTERVIEW_TERMS) !== null) ?? own[0] ?? '';
  return {
    relevant,
    matchedTerms,
    text: source,
    snippet: relevant ? makeSnippet(source) : '',
  };
}
