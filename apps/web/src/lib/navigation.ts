/** Where to go after signing in when nothing else was asked for. */
export const DEFAULT_LANDING = '/kits';

/**
 * Accepts a `next` value from the address bar only if it is a path inside this app. Anything that
 * could send the user to another site (a full URL, `//host`, `/\host`, a `javascript:` scheme,
 * control characters, an over-long value) falls back to the default, so a crafted login link
 * cannot be used as an open redirect.
 */
export function safeNextPath(
  next: string | null | undefined,
  fallback: string = DEFAULT_LANDING,
): string {
  if (!next || next.length > 512) return fallback;
  // Reject control characters and backslashes outright (browsers treat `\` like `/`).
  for (const ch of next) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || ch === '\\') return fallback;
  }
  if (!next.startsWith('/') || next.startsWith('//')) return fallback;
  let decoded: string;
  try {
    decoded = decodeURIComponent(next);
  } catch {
    return fallback;
  }
  // A percent-encoded `//` or backslash must not become one after decoding.
  if (
    decoded.startsWith('//') ||
    decoded.includes('\\') ||
    /^\/[a-z][a-z0-9+.-]*:/i.test(decoded)
  ) {
    return fallback;
  }
  return next;
}

/** The sign-in page, remembering where the user was going. */
export function loginHref(returnTo?: string | null, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  const target = safeNextPath(returnTo, '');
  if (target !== '' && target !== DEFAULT_LANDING) params.set('next', target);
  const query = params.toString();
  return query === '' ? '/login' : `/login?${query}`;
}
