import { createHash } from 'node:crypto';
import type { GenerationRequest } from '@trao/contracts';

const HASH_VERSION = 'v1';

function normalizeDescription(jd: string): string {
  return jd.replace(/\s+/g, ' ').trim();
}

function normalizeUrl(raw: string): string {
  const url = new URL(raw);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  return `${url.protocol}//${url.host}${path}${url.search}`; // protocol and host are lower-cased by URL
}

/**
 * Content hash used to deduplicate equivalent generation requests. It covers only the three
 * request fields — never credentials, cookies or user data — after normalising whitespace, line
 * endings, URL host case, trailing slash and fragment. The user id is not part of the hash; the
 * database index pairs it with the user id instead.
 */
export function hashGenerationInput(input: GenerationRequest): string {
  const canonical = JSON.stringify([
    HASH_VERSION,
    normalizeDescription(input.jd),
    normalizeUrl(input.company_url),
    input.days,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
