import { createHash } from 'node:crypto';
import { normalizeWords } from './text-match.js';

const SHINGLE_SIZE = 5;
const MIN_WORDS_FOR_NEAR_MATCH = 30;

export interface Fingerprint {
  /** Hash of the normalised words: equal for text that differs only in case, punctuation or spacing. */
  hash: string;
  wordCount: number;
  shingles: Set<string>;
}

export function fingerprint(text: string): Fingerprint {
  const normalized = normalizeWords(text);
  const words = normalized === '' ? [] : normalized.split(' ');
  const shingles = new Set<string>();
  for (let i = 0; i + SHINGLE_SIZE <= words.length; i++) {
    shingles.add(words.slice(i, i + SHINGLE_SIZE).join(' '));
  }
  return {
    hash: createHash('sha256').update(normalized).digest('hex'),
    wordCount: words.length,
    shingles,
  };
}

/** 1 for identical text; otherwise Jaccard similarity of word 5-grams. Short pages match exactly or not at all. */
export function similarity(a: Fingerprint, b: Fingerprint): number {
  if (a.hash === b.hash) return 1;
  if (a.wordCount < MIN_WORDS_FOR_NEAR_MATCH || b.wordCount < MIN_WORDS_FOR_NEAR_MATCH) return 0;
  let shared = 0;
  for (const s of a.shingles) if (b.shingles.has(s)) shared++;
  const union = a.shingles.size + b.shingles.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Remembers the pages seen so far and reports which earlier page a new one duplicates. */
export class ContentDeduper {
  private readonly seen: { url: string; fp: Fingerprint }[] = [];

  constructor(private readonly threshold = 0.9) {}

  /** Returns the URL of the page this one duplicates, or null if it is new (and then remembers it). */
  check(url: string, text: string): string | null {
    const fp = fingerprint(text);
    if (fp.wordCount === 0) return null;
    for (const earlier of this.seen) {
      if (similarity(earlier.fp, fp) >= this.threshold) return earlier.url;
    }
    this.seen.push({ url, fp });
    return null;
  }
}
