import { isIP } from 'node:net';
import { bareHostname } from './network-policy.js';
import { normalizeWords } from './text-match.js';

/**
 * Best-effort company name for the search step. This is an INFERENCE from the site (declared
 * site name, page title, domain, or a local fixture's path), never a fact, and the result says
 * where it came from. When nothing credible exists the answer is null rather than a guess.
 */

export type CompanyNameSource = 'site-name' | 'title' | 'hostname' | 'path';

export interface InferredName {
  name: string;
  source: CompanyNameSource;
}

const MAX_NAME_CHARS = 80;
const GENERIC =
  /\b(home|homepage|welcome|careers?|jobs?|about( us)?|official (web)?site|blog|log ?in|sign ?in|contact|index|untitled|page|website)\b/i;
const SECOND_LEVEL_MARKERS = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);

const clamp = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS).trim();
const isGeneric = (text: string) => text.trim() === '' || GENERIC.test(text);

function titleCase(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** The registrable-looking label of a hostname: acme.com → acme, www.acme-rockets.co.uk → acme-rockets. */
function hostLabel(hostname: string): string | null {
  const host = hostname.replace(/^www\./, '');
  if (host === 'localhost' || isIP(host) !== 0 || !host.includes('.')) return null;
  const parts = host.split('.');
  parts.pop(); // top-level domain
  const last = parts[parts.length - 1];
  if (parts.length > 1 && last !== undefined && SECOND_LEVEL_MARKERS.has(last)) parts.pop();
  return parts[parts.length - 1] ?? null;
}

export function inferCompanyName(
  rootUrl: URL,
  home: { title: string; siteName: string | null } | null,
): InferredName | null {
  const label = hostLabel(bareHostname(rootUrl));

  if (home?.siteName && !isGeneric(home.siteName)) {
    return { name: clamp(home.siteName), source: 'site-name' };
  }

  if (home?.title) {
    const segments = home.title
      .split(/\s*[|–—·•:]\s*|\s+-\s+/)
      .map((s) => s.trim())
      .filter((s) => s !== '' && !isGeneric(s));
    const wanted = label ? normalizeWords(label) : null;
    const match = wanted ? segments.find((s) => normalizeWords(s).includes(wanted)) : undefined;
    const chosen = match ?? segments[0];
    if (chosen) return { name: clamp(chosen), source: 'title' };
  }

  if (label) return { name: clamp(titleCase(label)), source: 'hostname' };

  const firstSegment = rootUrl.pathname.split('/').find((s) => s !== '');
  if (firstSegment && /^[a-z0-9][a-z0-9-_]*$/i.test(firstSegment) && !firstSegment.includes('.')) {
    return { name: clamp(titleCase(firstSegment)), source: 'path' };
  }
  return null;
}
