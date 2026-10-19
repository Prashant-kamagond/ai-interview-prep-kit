/** Helpers for matching phrases in untrusted text without regexes built from the text itself. */

/** Lower-cases and reduces everything that is not a letter or digit to single spaces. */
export function normalizeWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Whole-word phrase match on already-normalised text ("carpet" does not contain "career"). */
export function hasPhrase(normalized: string, phrase: string): boolean {
  return ` ${normalized} `.includes(` ${phrase} `);
}

export function firstPhrase(normalized: string, phrases: readonly string[]): string | null {
  return phrases.find((phrase) => hasPhrase(normalized, phrase)) ?? null;
}
