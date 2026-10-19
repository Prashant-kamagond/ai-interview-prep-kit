import { isIP } from 'node:net';
import { bareHostname, effectivePort } from './network-policy.js';

const TRACKING_PARAMS = /^(utm_.*|fbclid|gclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|ref_src)$/i;

/**
 * A key under which two URLs for the same page compare equal: scheme, `www.`, fragment, trailing
 * slash, `index.html` and tracking parameters are ignored. Path case is significant.
 */
export function urlKey(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const port = url.port ? `:${url.port}` : '';
  let path = url.pathname.replace(/\/index\.html?$/i, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  const params = [...url.searchParams].filter(([name]) => !TRACKING_PARAMS.test(name));
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : '';
  return `${host}${port}${path}${query}`;
}

/** Resolves an href against its page. Returns null for anything that is not a plain web link. */
export function resolveLink(href: string, base: URL): URL | null {
  const trimmed = href.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  try {
    const url = new URL(trimmed, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname === '' ? null : url;
  } catch {
    return null;
  }
}

export interface Scope {
  readonly rootHost: string;
  contains(url: URL): boolean;
}

const isDefaultPort = (port: number) => port === 80 || port === 443;
const stripWww = (host: string) => host.replace(/^www\./, '');

/**
 * What a crawl of one company site may follow: the root host (www ignored) and its subdomains —
 * so `careers.acme.com` is reachable from `acme.com` — and nothing else. It never climbs from a
 * subdomain to its parent, never crosses to a sibling, and for IP-literal or `localhost` roots it
 * means that exact host. Ports must match the root's (http/https defaults are interchangeable).
 * This is only a scope rule; SSRF validation is applied separately to every request.
 */
export function createScope(root: URL): Scope {
  const rootHost = stripWww(bareHostname(root));
  const exactOnly = isIP(rootHost) !== 0 || rootHost === 'localhost' || !rootHost.includes('.');
  const rootPort = effectivePort(root);

  return {
    rootHost,
    contains(url) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      const host = stripWww(bareHostname(url));
      const hostOk = host === rootHost || (!exactOnly && host.endsWith(`.${rootHost}`));
      if (!hostOk) return false;
      const port = effectivePort(url);
      return port === rootPort || (isDefaultPort(rootPort) && isDefaultPort(port));
    },
  };
}

const ASSET_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'svg',
  'webp',
  'avif',
  'ico',
  'bmp',
  'css',
  'js',
  'mjs',
  'map',
  'json',
  'xml',
  'rss',
  'atom',
  'pdf',
  'zip',
  'gz',
  'tgz',
  'rar',
  '7z',
  'mp3',
  'mp4',
  'webm',
  'mov',
  'avi',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'csv',
]);

// Whole path segments, so "/accounting-team" is fine but "/account/settings" is not.
const AUTH_SEGMENTS = new Set([
  'login',
  'log-in',
  'signin',
  'sign-in',
  'signup',
  'sign-up',
  'register',
  'logout',
  'log-out',
  'signout',
  'sign-out',
  'auth',
  'oauth',
  'oauth2',
  'sso',
  'account',
  'accounts',
  'password',
  'forgot-password',
  'reset-password',
  'cart',
  'checkout',
  'wp-admin',
  'wp-login.php',
  'admin',
]);
const AUTH_QUERY_KEYS = new Set(['logout', 'signout', 'log-out', 'sign-out']);

export type LinkProblem = 'asset' | 'auth';

/** Why a link must not be fetched while crawling for company information, if there is a reason. */
export function crawlableLinkProblem(url: URL): LinkProblem | null {
  const path = url.pathname.toLowerCase();
  const extension = /\.([a-z0-9]{1,5})$/.exec(path)?.[1];
  if (extension && ASSET_EXTENSIONS.has(extension)) return 'asset';
  if (path.split('/').some((segment) => AUTH_SEGMENTS.has(segment))) return 'auth';
  for (const key of url.searchParams.keys())
    if (AUTH_QUERY_KEYS.has(key.toLowerCase())) return 'auth';
  return null;
}
