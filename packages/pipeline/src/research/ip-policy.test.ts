import { describe, expect, it } from 'vitest';
import { classifyIp, parseIp } from './ip-policy.js';

describe('classifyIp', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['93.184.216.34', 'public'],
    ['172.32.0.1', 'public'], // just outside 172.16/12
    ['172.15.255.255', 'public'],
    ['100.63.255.255', 'public'], // just below CGNAT
    ['100.128.0.1', 'public'], // just above CGNAT
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.0.1', 'private'],
    ['169.254.169.254', 'link-local'], // cloud metadata endpoint
    ['100.64.0.1', 'shared'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['192.0.0.1', 'reserved'],
    ['192.0.2.1', 'documentation'],
    ['198.51.100.1', 'documentation'],
    ['203.0.113.1', 'documentation'],
    ['198.18.0.1', 'benchmark'],
  ])('IPv4 %s is %s', (address, expected) => {
    expect(classifyIp(address)).toBe(expected);
  });

  it.each([
    ['2606:4700:4700::1111', 'public'],
    ['2001:4860:4860::8888', 'public'],
    ['2a00:1450:4001:81b::200e', 'public'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['febf::1', 'link-local'],
    ['fc00::1', 'private'],
    ['fd12:3456:789a::1', 'private'],
    ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'loopback'], // IPv4-mapped
    ['::ffff:7f00:1', 'loopback'], // same, hex form
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['::ffff:8.8.8.8', 'public'],
    ['64:ff9b::7f00:1', 'reserved'], // NAT64 wrapping 127.0.0.1
    ['2002:7f00:1::1', 'reserved'], // 6to4 wrapping 127.0.0.1
    ['2001:db8::1', 'documentation'],
    ['2001::1', 'reserved'], // Teredo / IETF assignments
    ['100::1', 'reserved'], // discard-only
    ['fec0::1', 'reserved'], // deprecated site-local
    ['1::1', 'reserved'], // outside 2000::/3
  ])('IPv6 %s is %s', (address, expected) => {
    expect(classifyIp(address)).toBe(expected);
  });

  it('treats anything unparseable as not public', () => {
    for (const bad of [
      '',
      'abc',
      '1.2.3',
      '1.2.3.4.5',
      '256.1.1.1',
      '::g',
      '1::2::3',
      'fe80::1%eth0',
    ]) {
      expect(classifyIp(bad), bad).toBe('invalid');
    }
  });
});

describe('parseIp', () => {
  it('parses IPv4 and IPv6 into bytes', () => {
    expect(parseIp('1.2.3.4')).toEqual({ family: 4, bytes: [1, 2, 3, 4] });
    const v6 = parseIp('2001:db8::1');
    expect(v6?.family).toBe(6);
    expect(v6?.bytes).toHaveLength(16);
    expect(v6?.bytes.slice(0, 4)).toEqual([0x20, 0x01, 0x0d, 0xb8]);
    expect(v6?.bytes[15]).toBe(1);
  });

  it('handles a dotted-quad tail in IPv6', () => {
    expect(parseIp('::ffff:1.2.3.4')?.bytes.slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
  });

  it('rejects leading zeros in IPv4 octets (ambiguous octal)', () => {
    expect(parseIp('010.0.0.1')).toBeNull();
  });
});
