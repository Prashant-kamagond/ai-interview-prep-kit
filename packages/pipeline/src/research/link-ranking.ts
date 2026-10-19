import type { ExtractedLink } from './html.js';
import { firstPhrase, normalizeWords } from './text-match.js';
import { crawlableLinkProblem, urlKey } from './url-utils.js';

/**
 * Deterministic link scoring: the same links always produce the same scores and the same order,
 * with no randomness and no model. Signals come from the visible anchor text, the title/aria
 * attributes, the URL path, where the link sits on the page and the text around it.
 *
 * The score decides what is worth fetching first. It does not decide what is a hiring page:
 * companies word these links unpredictably, so every fetched page is re-judged by its own content
 * (see hiring.ts). A page whose link scores poorly can still be found that way.
 */

// Phrases are matched as whole words on normalised text ("we're hiring" → "we re hiring").
const HIRING_STRONG = [
  'careers',
  'career',
  'jobs',
  'job openings',
  'job board',
  'open positions',
  'open roles',
  'openings',
  'join us',
  'join our team',
  'join the team',
  'work with us',
  'work at',
  'work for us',
  'we are hiring',
  'we re hiring',
  'now hiring',
  'hiring',
  'recruiting',
  'recruitment',
  'vacancies',
  'opportunities',
  'employment',
  'talent acquisition',
];
const INTERVIEW = [
  'interview',
  'interviews',
  'interviewing',
  'interview process',
  'how we interview',
  'hiring process',
  'how we hire',
  'hiring guide',
  'candidate experience',
  'selection process',
];
const HIRING_MEDIUM = [
  'come build',
  'build with us',
  'grow with us',
  'be part of',
  'life at',
  'join',
  'apply',
  'talent',
];
const HIRING_WEAK = [
  'team',
  'teams',
  'people',
  'culture',
  'handbook',
  'engineering blog',
  'engineering',
  'blog',
  'life',
  'work',
  'values',
  'crew',
];
const ABOUT_STRONG = [
  'about',
  'about us',
  'company',
  'who we are',
  'our story',
  'mission',
  'our mission',
  'what we do',
  'overview',
];
const ABOUT_WEAK = ['product', 'products', 'platform', 'solutions', 'services'];
const NOISE = [
  'privacy',
  'privacy policy',
  'terms',
  'terms of service',
  'terms and conditions',
  'cookies',
  'cookie',
  'cookie policy',
  'legal',
  'imprint',
  'sitemap',
  'accessibility',
  'gdpr',
];

// Weights by where the evidence was found.
const W = {
  anchor: { interview: 7, strong: 6, medium: 4, weak: 1.5, about: 4, aboutWeak: 1.5 },
  path: { interview: 6, strong: 5, medium: 3, weak: 1, about: 3, aboutWeak: 1 },
  title: 0.9, // title / aria-label count as 90% of the same evidence in anchor text
};
const CONTEXT_BONUS: Record<ExtractedLink['context'], number> = {
  nav: 0.5,
  header: 0.5,
  footer: 0.5,
  main: 0,
  other: 0,
};
const SURROUNDING_BONUS = 1;
const NOISE_PENALTY = 6;

export interface LinkScore {
  /** Overall priority for fetching. Zero or below means "not worth a request". */
  score: number;
  hiringScore: number;
  aboutScore: number;
  reasons: string[];
}

type Field = keyof Pick<typeof W, 'anchor' | 'path'>;

function best(
  normalized: string,
  field: Field,
  multiplier: number,
  label: string,
  kind: 'hiring' | 'about',
): { score: number; reason: string | null } {
  const w = W[field];
  const tiers: [readonly string[], number][] =
    kind === 'hiring'
      ? [
          [INTERVIEW, w.interview],
          [HIRING_STRONG, w.strong],
          [HIRING_MEDIUM, w.medium],
          [HIRING_WEAK, w.weak],
        ]
      : [
          [ABOUT_STRONG, w.about],
          [ABOUT_WEAK, w.aboutWeak],
        ];
  for (const [phrases, weight] of tiers) {
    const hit = firstPhrase(normalized, phrases);
    if (hit) {
      const value = weight * multiplier;
      return { score: value, reason: `${label} matches "${hit}" (+${Number(value.toFixed(2))})` };
    }
  }
  return { score: 0, reason: null };
}

export function scoreLink(link: ExtractedLink): LinkScore {
  const reasons: string[] = [];
  const anchor = normalizeWords(link.text);
  const title = normalizeWords(link.title);
  const path = normalizeWords(decodeURIComponentSafe(link.url.pathname));

  let hiring = 0;
  let about = 0;
  const take = (r: { score: number; reason: string | null }, kind: 'hiring' | 'about') => {
    if (r.score === 0) return;
    if (kind === 'hiring') hiring += r.score;
    else about += r.score;
    if (r.reason) reasons.push(r.reason);
  };

  take(best(anchor, 'anchor', 1, 'anchor text', 'hiring'), 'hiring');
  take(best(title, 'anchor', W.title, 'title/aria-label', 'hiring'), 'hiring');
  take(best(path, 'path', 1, 'url path', 'hiring'), 'hiring');
  take(best(anchor, 'anchor', 1, 'anchor text', 'about'), 'about');
  take(best(title, 'anchor', W.title, 'title/aria-label', 'about'), 'about');
  take(best(path, 'path', 1, 'url path', 'about'), 'about');

  const near = normalizeWords(link.surrounding);
  if (firstPhrase(near, [...HIRING_STRONG, ...INTERVIEW])) {
    hiring += SURROUNDING_BONUS;
    reasons.push(`nearby text mentions hiring (+${SURROUNDING_BONUS})`);
  }

  const noisy = firstPhrase(anchor, NOISE) ?? firstPhrase(path, NOISE);
  const penalty = noisy ? NOISE_PENALTY : 0;
  if (noisy) reasons.push(`legal/policy page "${noisy}" (-${NOISE_PENALTY})`);

  const bonus = CONTEXT_BONUS[link.context];
  if (bonus > 0) reasons.push(`link is in the ${link.context} (+${bonus})`);

  const score = Math.max(hiring, about * 0.8) + bonus - penalty;
  return { score, hiringScore: hiring, aboutScore: about, reasons };
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface RankedLink extends LinkScore {
  link: ExtractedLink;
  key: string;
}

/**
 * One entry per page (best score among duplicates), excluding links that must never be followed
 * (assets, login/logout/account pages, rel=nofollow). Sorted by score, then by URL for stability.
 */
export function rankLinks(links: readonly ExtractedLink[]): RankedLink[] {
  const byKey = new Map<string, RankedLink>();
  for (const link of links) {
    if (link.nofollow || crawlableLinkProblem(link.url) !== null) continue;
    const key = urlKey(link.url);
    const scored: RankedLink = { ...scoreLink(link), link, key };
    const existing = byKey.get(key);
    if (
      !existing ||
      scored.score > existing.score ||
      (scored.score === existing.score && link.url.href < existing.link.url.href)
    ) {
      byKey.set(key, scored);
    }
  }
  return [...byKey.values()].sort(
    (a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}
