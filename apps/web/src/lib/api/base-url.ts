/**
 * Where the browser finds the API.
 *
 * `NEXT_PUBLIC_API_URL` is baked into the web bundle when it is BUILT, so a deployment that forgot it would
 * ship a bundle that quietly calls `http://localhost:4000` from every visitor's own machine. These rules
 * make that impossible to do silently:
 *
 *  - on this developer's machine (the page itself is served from a loopback host) an unset URL means the
 *    local default, so `pnpm dev` and a local `next start` keep working;
 *  - anywhere else (a real host name) an unset URL is a configuration error, and so is a URL that points at
 *    a loopback host or does not use https. The app then says it is misconfigured instead of calling
 *    anything.
 *
 * The same rules are applied at build time by `scripts/check-production-env.ts` (`pnpm build:production`),
 * which a deployment should use, so the mistake fails the build instead of reaching a visitor.
 */

export const LOCAL_API_URL = 'http://localhost:4000';

export class ApiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiConfigError';
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    h === '0.0.0.0' ||
    /^127(\.\d{1,3}){3}$/.test(h)
  );
}

/** Problems with an API address meant for a real deployment. Empty means it is fit to ship. */
export function problemsWithDeployedApiUrl(raw: string | undefined): string[] {
  const value = (raw ?? '').trim();
  if (value === '') return ['NEXT_PUBLIC_API_URL is not set'];
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return ['NEXT_PUBLIC_API_URL is not a valid URL'];
  }
  const problems: string[] = [];
  if (url.protocol !== 'https:') problems.push('NEXT_PUBLIC_API_URL must use https');
  if (isLoopbackHost(url.hostname))
    problems.push('NEXT_PUBLIC_API_URL points at a loopback host (localhost)');
  if (url.username !== '' || url.password !== '')
    problems.push('NEXT_PUBLIC_API_URL must not contain credentials');
  return problems;
}

export interface BaseUrlInput {
  /** The configured address (`NEXT_PUBLIC_API_URL`, or an explicit one passed in). */
  explicit: string | undefined;
  /** The host name the page is served from; null when there is no page (server rendering, tests in Node). */
  pageHostname: string | null;
}

/** The API address to use, or an ApiConfigError saying what is wrong. Never a silent localhost on a real host. */
export function resolveApiBaseUrl({ explicit, pageHostname }: BaseUrlInput): string {
  const value = (explicit ?? '').trim();
  const deployed = pageHostname !== null && !isLoopbackHost(pageHostname);

  if (value === '') {
    if (deployed) {
      throw new ApiConfigError(
        'NEXT_PUBLIC_API_URL is not set, so this deployment does not know where its API is',
      );
    }
    return LOCAL_API_URL;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiConfigError('NEXT_PUBLIC_API_URL is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiConfigError('NEXT_PUBLIC_API_URL must be an http(s) URL');
  }
  if (deployed) {
    const problems = problemsWithDeployedApiUrl(value);
    if (problems.length > 0) throw new ApiConfigError(problems.join('; '));
  }
  return value.replace(/\/+$/, '');
}
