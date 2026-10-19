import type { ExtractedPage } from './html.js';
import { firstPhrase, hasPhrase, normalizeWords } from './text-match.js';

/**
 * Judges a fetched page by its own content: is it about hiring, does it describe how the company
 * interviews, is it an about page? This is a transparent heuristic, deliberately not a model call.
 * Its output is a classification (an inference); the page text and the quoted interview mentions
 * remain the observed evidence, and mentions are copied verbatim from the page.
 */

export type PageRole = 'home' | 'about' | 'hiring' | 'hiring-process' | 'other';

export interface PageClassification {
  role: Exclude<PageRole, 'home'>;
  hiringScore: number;
  /** Strength of interview-process evidence: 2 per distinct cue. */
  processScore: number;
  /** Plain observations that led to the classification. */
  evidence: string[];
  /** Sentences quoted verbatim from the page that mention interviewing. */
  interviewMentions: string[];
}

const HIRING_TERMS = [
  'careers',
  'career',
  'jobs',
  'job openings',
  'open positions',
  'open roles',
  'openings',
  'join us',
  'join our team',
  'join the team',
  'work with us',
  'we are hiring',
  'we re hiring',
  'now hiring',
  'hiring',
  'recruiting',
  'recruitment',
  'vacancies',
  'opportunities',
  'talent acquisition',
];
const LISTING_CUES = [
  'apply now',
  'open positions',
  'open roles',
  'we are hiring',
  'we re hiring',
  'now hiring',
  'view all jobs',
  'current openings',
  'job openings',
  'equal opportunity',
  'full time',
  'part time',
];
const PROCESS_CUES = [
  'interview process',
  'hiring process',
  'our interview',
  'interview stages',
  'interview stage',
  'interview round',
  'interview rounds',
  'take home',
  'system design',
  'coding interview',
  'technical interview',
  'phone screen',
  'recruiter screen',
  'onsite',
  'on site',
  'final round',
  'how we hire',
  'how we interview',
  'behavioral interview',
  'behavioural interview',
  'culture interview',
  'values interview',
];
const ABOUT_TERMS = [
  'about',
  'about us',
  'company',
  'who we are',
  'our story',
  'mission',
  'what we do',
];

const HIRING_THRESHOLD = 6;
const PROCESS_THRESHOLD = 4;
const MAX_MENTIONS = 5;
const MAX_MENTION_CHARS = 240;
const MAX_LISTING_POINTS = 5;
const MAX_PROCESS_POINTS_IN_HIRING = 4;

function sentences(text: string): string[] {
  return text
    .split('\n')
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export function classifyPage(url: URL, page: ExtractedPage): PageClassification {
  const evidence: string[] = [];
  let score = 0;

  const pathWords = normalizeWords(decodeURIComponent(url.pathname));
  const titleWords = normalizeWords(page.title);
  const h1Words = page.headings.slice(0, 1).map(normalizeWords);
  const otherHeadings = page.headings.slice(1).map(normalizeWords);
  const textWords = normalizeWords(page.text);

  const processTerms = [...PROCESS_CUES];
  const urlHit = firstPhrase(pathWords, [...HIRING_TERMS, ...processTerms]);
  if (urlHit) {
    score += 3;
    evidence.push(`url path contains "${urlHit}"`);
  }
  const titleHit = firstPhrase(titleWords, [
    ...HIRING_TERMS,
    ...processTerms,
    'interview',
    'interviews',
  ]);
  if (titleHit) {
    score += 4;
    evidence.push(`title mentions "${titleHit}"`);
  }
  for (const h of h1Words) {
    const hit = firstPhrase(h, [...HIRING_TERMS, ...processTerms, 'interview', 'interviews']);
    if (hit) {
      score += 3;
      evidence.push(`heading mentions "${hit}"`);
    }
  }
  for (const h of otherHeadings) {
    if (firstPhrase(h, [...HIRING_TERMS, ...processTerms])) {
      score += 1;
      break;
    }
  }

  const listingHits = LISTING_CUES.filter((cue) => hasPhrase(textWords, cue));
  const listingPoints = Math.min(listingHits.length, MAX_LISTING_POINTS);
  score += listingPoints;
  for (const cue of listingHits.slice(0, 3)) evidence.push(`text mentions "${cue}"`);

  // Process cues are looked for in the title, headings and body together.
  const everything = [titleWords, ...h1Words, ...otherHeadings, textWords].join(' ');
  const processHits = PROCESS_CUES.filter((cue) => hasPhrase(everything, cue));
  const processScore = processHits.length * 2;
  score += Math.min(processScore, MAX_PROCESS_POINTS_IN_HIRING);
  for (const cue of processHits.slice(0, 4)) evidence.push(`text mentions "${cue}"`);

  const mentions: string[] = [];
  for (const sentence of sentences(page.text)) {
    const words = normalizeWords(sentence);
    if (!firstPhrase(words, [...PROCESS_CUES, 'interview', 'interviews', 'interviewing'])) continue;
    const quoted =
      sentence.length > MAX_MENTION_CHARS ? sentence.slice(0, MAX_MENTION_CHARS) : sentence;
    if (!mentions.includes(quoted)) mentions.push(quoted);
    if (mentions.length >= MAX_MENTIONS) break;
  }

  let role: PageClassification['role'] = 'other';
  if (processScore >= PROCESS_THRESHOLD) role = 'hiring-process';
  else if (score >= HIRING_THRESHOLD) role = 'hiring';
  else if (
    firstPhrase(pathWords, ABOUT_TERMS) ||
    firstPhrase(titleWords, ABOUT_TERMS) ||
    h1Words.some((h) => firstPhrase(h, ABOUT_TERMS))
  ) {
    role = 'about';
  }

  return { role, hiringScore: score, processScore, evidence, interviewMentions: mentions };
}
