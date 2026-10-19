import { isIP } from 'node:net';
import { FetchError } from './errors.js';
import { classifyIp } from './ip-policy.js';

/**
 * Which destinations the research layer may contact.
 *
 * Production: public unicast addresses on a small set of ports, nothing else.
 *
 * Development, tests and the batch CLI additionally need local fixture sites. That is granted
 * through `loopbackHosts`: an explicit list of `host:port` pairs (normally just the host named by
 * the case's own company URL). It permits LOOPBACK addresses for exactly those pairs. It does not
 * unlock private ranges, link-local/metadata addresses, other loopback ports, or other hosts, so a
 * public site that redirects to `127.0.0.1:<other port>` or `169.254.169.254` is still refused.
 * Creating a policy with a loopback list while NODE_ENV is production throws.
 */
export interface NetworkPolicy {
  readonly allowedPorts: ReadonlySet<number>;
  readonly loopbackHosts: ReadonlySet<string>;
}

export interface NetworkPolicyOptions {
  /** `host:port` pairs (IPv6 hosts in brackets). */
  loopbackHosts?: Iterable<string>;
  allowedPorts?: Iterable<number>;
  nodeEnv?: string | undefined;
}

export const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443, 8080, 8443];
const MAX_URL_LENGTH = 2048;
const BLOCKED_NAME_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

export function createNetworkPolicy(options: NetworkPolicyOptions = {}): NetworkPolicy {
  const loopbackHosts = new Set(
    [...(options.loopbackHosts ?? [])].map((h) => h.trim().toLowerCase()),
  );
  if (options.nodeEnv === 'production' && loopbackHosts.size > 0) {
    throw new Error('Loopback research hosts must not be enabled in production');
  }
  return {
    allowedPorts: new Set(options.allowedPorts ?? DEFAULT_ALLOWED_PORTS),
    loopbackHosts,
  };
}

export function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/** `hostname:port`, lower-case, IPv6 hosts bracketed, as used by the loopback allow-list. */
export function hostKey(url: URL): string {
  return `${url.hostname.toLowerCase()}:${effectivePort(url)}`;
}

/** The hostname without IPv6 brackets or a trailing root dot. */
export function bareHostname(url: URL): string {
  return url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

/**
 * Syntactic and literal-address checks. Hostnames are checked again, against what they actually
 * resolve to, at connection time (see safe-fetch's pinned lookup).
 */
export function validateUrl(raw: string | URL, policy: NetworkPolicy): URL {
  let url: URL;
  if (typeof raw === 'string') {
    if (raw.length === 0 || raw.length > MAX_URL_LENGTH) {
      throw new FetchError('INVALID_URL', 'The URL is empty or too long');
    }
    try {
      url = new URL(raw);
    } catch {
      throw new FetchError('INVALID_URL', 'The URL is not valid');
    }
  } else {
    url = raw;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchError('INVALID_URL', 'Only http and https URLs are supported');
  }
  if (url.username !== '' || url.password !== '') {
    throw new FetchError('INVALID_URL', 'URLs with embedded credentials are not allowed');
  }
  const host = bareHostname(url);
  if (host === '') throw new FetchError('INVALID_URL', 'The URL has no host');

  const key = hostKey(url);
  const loopbackAllowed = policy.loopbackHosts.has(key);
  if (!policy.allowedPorts.has(effectivePort(url)) && !loopbackAllowed) {
    throw new FetchError('INVALID_URL', 'That port is not permitted');
  }

  if (isIP(host) !== 0) {
    const cls = classifyIp(host);
    if (cls === 'public' || (cls === 'loopback' && loopbackAllowed)) return url;
    throw new FetchError('BLOCKED_ADDRESS', `Destination is not a public address (${cls})`);
  }

  if (
    !loopbackAllowed &&
    (host === 'localhost' || BLOCKED_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix)))
  ) {
    throw new FetchError('BLOCKED_ADDRESS', 'Destination is a local or internal name');
  }
  return url;
}

/**
 * Checks what a hostname resolved to. Every address must be acceptable: if even one is private
 * the whole answer is rejected, so the connection can never fall back to it.
 */
export function checkResolvedAddresses(
  url: URL,
  addresses: readonly string[],
  policy: NetworkPolicy,
): void {
  if (addresses.length === 0) throw new FetchError('DNS_FAILED', 'The host did not resolve');
  const loopbackAllowed = policy.loopbackHosts.has(hostKey(url));
  for (const address of addresses) {
    const cls = classifyIp(address);
    if (cls === 'public' || (cls === 'loopback' && loopbackAllowed)) continue;
    // The address itself is deliberately left out of the message.
    throw new FetchError(
      'BLOCKED_ADDRESS',
      `Destination resolves to a non-public address (${cls})`,
    );
  }
}
