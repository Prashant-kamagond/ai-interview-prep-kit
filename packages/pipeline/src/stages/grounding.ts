import { hasPhrase, normalizeWords } from '../research/text-match.js';

/**
 * Checks that make model output answer to its source. A requirement is only kept if the sentence
 * it cites really appears in the job description; a claim about a company only if its quote
 * really appears on the cited page. Matching ignores case, punctuation and whitespace but is
 * otherwise exact and whole-word.
 */

const MIN_QUOTE_CHARS = 3;
const MIN_OVERLAP = 0.5;

export function isGrounded(quote: string, source: string): boolean {
  const q = normalizeWords(quote);
  if (q.length < MIN_QUOTE_CHARS) return false;
  return hasPhrase(normalizeWords(source), q);
}

/** The word position of the quote in the source (for ordering by appearance), or -1. */
export function positionInSource(quote: string, source: string): number {
  const q = normalizeWords(quote);
  if (q === '') return -1;
  const hay = ` ${normalizeWords(source)} `;
  const at = hay.indexOf(` ${q} `);
  if (at === -1) return -1;
  return hay.slice(0, at).split(' ').filter(Boolean).length;
}

/** Keeps `value` only if every word in it appears in the source; otherwise an empty string. */
export function groundedWords(value: string, source: string): string {
  const words = normalizeWords(value).split(' ').filter(Boolean);
  if (words.length === 0) return '';
  const known = new Set(normalizeWords(source).split(' '));
  return words.every((w) => known.has(w)) ? value.trim() : '';
}

/** A restatement may tidy a quote but not drift from it: most of its words must come from the quote. */
export function textStaysCloseToQuote(text: string, quote: string): boolean {
  const content = normalizeWords(text)
    .split(' ')
    .filter((w) => w.length >= 3);
  if (content.length === 0) return true;
  const known = new Set(normalizeWords(quote).split(' '));
  return content.filter((w) => known.has(w)).length / content.length >= MIN_OVERLAP;
}

const NICE_INLINE =
  /\b(nice to have|nice-to-have|bonus|a plus|is a plus|are a plus|preferred|desirable|ideally|would be (?:great|nice)|not required|optional|good to have)\b/i;
const MUST_INLINE =
  /\b(required|requires?|must|mandatory|essential|minimum of|need to|needs to)\b/i;
const NICE_HEADING =
  /(nice[\s-]*to[\s-]*have|bonus|preferred|desirable|a plus|plus points?|extra credit|good to have|ideally|optional)/i;
const MUST_HEADING =
  /(requirements?|must[\s-]*have|required|qualifications?|what you(?:'|’)?ll need|what you will need|what we(?:'|’)?re looking for|you have|you bring|you(?:'|’)?ll bring|minimum|essential|basic|who you are)/i;

const BULLET = /^\s*(?:[-*•·–]|\d+[.)])\s+/;
const MAX_HEADING_CHARS = 80;

function isHeadingLike(line: string): boolean {
  const t = line.trim();
  if (t === '' || BULLET.test(line) || t.length > MAX_HEADING_CHARS) return false;
  return t.endsWith(':') || !/[.!?]$/.test(t);
}

function findLine(lines: readonly string[], quote: string): number {
  const q = normalizeWords(quote);
  if (q === '') return -1;
  for (let i = 0; i < lines.length; i++) {
    if (hasPhrase(normalizeWords(lines[i]!), q)) return i;
  }
  // A quote can run across a line break.
  for (let i = 0; i + 1 < lines.length; i++) {
    if (hasPhrase(normalizeWords(`${lines[i]} ${lines[i + 1]}`), q)) return i;
  }
  return -1;
}

export interface PriorityCue {
  priority: 'must' | 'nice';
  /** Human-readable, for audit. */
  reason: string;
}

/**
 * Reads how the posting itself words a requirement, so "required" and "bonus points for" are not
 * left to the model's judgement. Inline wording on the line wins; otherwise the nearest heading
 * above decides ("Nice to have:", "Requirements:"). A neutral heading ends the search. Returns
 * null when the posting gives no cue.
 */
export function inferPriority(quote: string, source: string): PriorityCue | null {
  const lines = source.split(/\r?\n/);
  const at = findLine(lines, quote);
  if (at === -1) return null;

  const line = lines[at]!;
  const nice = NICE_INLINE.exec(line);
  if (nice) return { priority: 'nice', reason: `the posting says "${nice[0]}" on this line` };
  const must = MUST_INLINE.exec(line);
  if (must) return { priority: 'must', reason: `the posting says "${must[0]}" on this line` };

  for (let i = at - 1; i >= 0; i--) {
    const above = lines[i]!;
    if (!isHeadingLike(above)) continue;
    const heading = above.trim();
    if (NICE_HEADING.test(heading))
      return { priority: 'nice', reason: `listed under the heading "${heading}"` };
    if (MUST_HEADING.test(heading))
      return { priority: 'must', reason: `listed under the heading "${heading}"` };
    return null; // the nearest heading is neutral: do not inherit one from further up
  }
  return null;
}
