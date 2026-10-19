/**
 * IP address classification for SSRF protection. Pure, table-driven, no dependencies.
 *
 * An address is `public` only if it is globally routable unicast. Everything else — loopback,
 * RFC 1918 private space, link-local (including the 169.254.169.254 cloud metadata endpoint),
 * carrier-grade NAT, multicast, documentation, benchmarking, translation and reserved ranges — is
 * not, as is anything that does not parse. IPv6 addresses that wrap an IPv4 address (IPv4-mapped)
 * are classified by the IPv4 address they carry.
 */

export type IpClass =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'shared'
  | 'multicast'
  | 'unspecified'
  | 'documentation'
  | 'benchmark'
  | 'reserved'
  | 'invalid';

export interface ParsedIp {
  family: 4 | 6;
  bytes: number[];
}

function parseIpv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    // Reject empty parts, signs, hex, and leading zeros (ambiguous octal in some parsers).
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

function parseIpv6(text: string): number[] | null {
  if (text.includes('%')) return null; // zone identifiers are not routable destinations

  let head = text;
  let tail = '';
  const double = text.indexOf('::');
  const hasDouble = double !== -1;
  if (hasDouble) {
    if (text.indexOf('::', double + 1) !== -1) return null; // more than one "::"
    head = text.slice(0, double);
    tail = text.slice(double + 2);
  }

  const toGroups = (section: string): number[] | null => {
    if (section === '') return [];
    const groups: number[] = [];
    const pieces = section.split(':');
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      if (piece.includes('.')) {
        // A dotted quad is only valid as the very last piece.
        if (i !== pieces.length - 1) return null;
        const v4 = parseIpv4(piece);
        if (!v4) return null;
        groups.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
        groups.push(parseInt(piece, 16));
      }
    }
    return groups;
  };

  const headGroups = toGroups(head);
  const tailGroups = toGroups(tail);
  if (!headGroups || !tailGroups) return null;

  let groups: number[];
  if (hasDouble) {
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 1) return null;
    groups = [...headGroups, ...new Array<number>(missing).fill(0), ...tailGroups];
  } else {
    groups = headGroups;
  }
  if (groups.length !== 8) return null;

  return groups.flatMap((g) => [(g >> 8) & 0xff, g & 0xff]);
}

export function parseIp(address: string): ParsedIp | null {
  if (address.includes(':')) {
    const bytes = parseIpv6(address);
    return bytes ? { family: 6, bytes } : null;
  }
  const bytes = parseIpv4(address);
  return bytes ? { family: 4, bytes } : null;
}

/** [network, prefix length, class] — first match wins, so more specific entries come first. */
type Rule = [number[], number, IpClass];

const IPV4_RULES: Rule[] = [
  [[0, 0, 0, 0], 8, 'unspecified'],
  [[10, 0, 0, 0], 8, 'private'],
  [[100, 64, 0, 0], 10, 'shared'],
  [[127, 0, 0, 0], 8, 'loopback'],
  [[169, 254, 0, 0], 16, 'link-local'],
  [[172, 16, 0, 0], 12, 'private'],
  [[192, 0, 0, 0], 24, 'reserved'],
  [[192, 0, 2, 0], 24, 'documentation'],
  [[192, 88, 99, 0], 24, 'reserved'],
  [[192, 168, 0, 0], 16, 'private'],
  [[198, 18, 0, 0], 15, 'benchmark'],
  [[198, 51, 100, 0], 24, 'documentation'],
  [[203, 0, 113, 0], 24, 'documentation'],
  [[224, 0, 0, 0], 4, 'multicast'],
  [[240, 0, 0, 0], 4, 'reserved'], // includes 255.255.255.255
];

function pad16(prefix: number[]): number[] {
  return [...prefix, ...new Array<number>(16 - prefix.length).fill(0)];
}

const IPV6_RULES: Rule[] = [
  [pad16([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), 128, 'loopback'],
  [pad16([]), 128, 'unspecified'],
  [pad16([0xfe, 0x80]), 10, 'link-local'],
  [pad16([0xfc]), 7, 'private'], // unique local
  [pad16([0xff]), 8, 'multicast'],
  [pad16([0x20, 0x01]), 23, 'reserved'], // IETF protocol assignments: Teredo, ORCHID, benchmarking…
  [pad16([0x20, 0x01, 0x0d, 0xb8]), 32, 'documentation'],
  [pad16([0x20, 0x02]), 16, 'reserved'], // 6to4 (embeds an arbitrary IPv4 address)
  [pad16([0x3f, 0xff]), 20, 'documentation'],
];

function matches(bytes: number[], network: number[], prefix: number): boolean {
  const fullBytes = Math.floor(prefix / 8);
  for (let i = 0; i < fullBytes; i++) if (bytes[i] !== network[i]) return false;
  const rest = prefix % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (bytes[fullBytes]! & mask) === (network[fullBytes]! & mask);
}

function classifyV4(bytes: number[]): IpClass {
  for (const [network, prefix, cls] of IPV4_RULES) if (matches(bytes, network, prefix)) return cls;
  return 'public';
}

function classifyV6(bytes: number[]): IpClass {
  // ::ffff:a.b.c.d (IPv4-mapped): the address that will actually be contacted is the IPv4 one.
  const mapped =
    bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return classifyV4(bytes.slice(12));

  for (const [network, prefix, cls] of IPV6_RULES) if (matches(bytes, network, prefix)) return cls;

  // Only 2000::/3 is allocated for global unicast. Everything else (NAT64 64:ff9b::/96,
  // deprecated site-local, discard-only 100::/64, IPv4-compatible ::a.b.c.d, …) is refused.
  return matches(bytes, pad16([0x20]), 3) ? 'public' : 'reserved';
}

export function classifyIp(address: string): IpClass {
  const ip = parseIp(address);
  if (!ip) return 'invalid';
  return ip.family === 4 ? classifyV4(ip.bytes) : classifyV6(ip.bytes);
}
