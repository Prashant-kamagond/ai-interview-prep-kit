import { describe, expect, it } from 'vitest';
import { FetchError } from './errors.js';
import {
  checkResolvedAddresses,
  createNetworkPolicy,
  hostKey,
  validateUrl,
} from './network-policy.js';

const strict = createNetworkPolicy();

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof FetchError) return err.code;
    throw err;
  }
  return 'NO_ERROR';
}

describe('validateUrl', () => {
  it.each([
    'https://example.com/careers',
    'http://example.com',
    'https://sub.example.co.uk:8443/a?b=1#frag',
    'http://8.8.8.8/',
    'https://[2606:4700:4700::1111]/',
  ])('accepts %s', (url) => {
    expect(codeOf(() => validateUrl(url, strict))).toBe('NO_ERROR');
  });

  it.each([
    ['empty string', ''],
    ['no scheme', 'example.com'],
    ['garbage', 'not a url'],
    ['ftp', 'ftp://example.com/file'],
    ['file', 'file:///etc/passwd'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<h1>x</h1>'],
    ['gopher', 'gopher://example.com'],
    ['embedded username', 'http://user@example.com/'],
    ['embedded credentials', 'https://user:secret@example.com/'],
    ['no host', 'http://'],
    ['disallowed port (ssh)', 'http://example.com:22/'],
    ['disallowed port (redis)', 'http://example.com:6379/'],
    ['over-long url', `http://example.com/${'a'.repeat(3000)}`],
  ])('rejects %s as INVALID_URL', (_name, url) => {
    expect(codeOf(() => validateUrl(url, strict))).toBe('INVALID_URL');
  });

  it.each([
    ['loopback v4', 'http://127.0.0.1/'],
    ['loopback v4 non-standard', 'http://127.1/'],
    ['loopback decimal', 'http://2130706433/'],
    ['loopback hex', 'http://0x7f000001/'],
    ['loopback hex dotted', 'http://0x7f.0.0.1/'],
    ['loopback octal', 'http://0177.0.0.1/'],
    ['loopback v6', 'http://[::1]/'],
    ['mapped loopback', 'http://[::ffff:7f00:1]/'],
    ['mapped loopback dotted', 'http://[::ffff:127.0.0.1]/'],
    ['private 10/8', 'http://10.1.2.3/'],
    ['private 192.168', 'https://192.168.1.1/'],
    ['private 172.16', 'http://172.16.5.5/'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['unspecified', 'http://0.0.0.0/'],
    ['unique-local v6', 'http://[fd00::1]/'],
    ['link-local v6', 'http://[fe80::1]/'],
    ['localhost name', 'http://localhost/'],
    ['localhost subdomain', 'http://app.localhost/'],
    ['localhost trailing dot', 'http://localhost./'],
    ['.local', 'http://printer.local/'],
    ['.internal', 'http://db.internal/'],
  ])('rejects %s as BLOCKED_ADDRESS', (_name, url) => {
    expect(codeOf(() => validateUrl(url, strict))).toBe('BLOCKED_ADDRESS');
  });

  it('returns a normalised URL object', () => {
    expect(validateUrl('HTTPS://Example.COM:443/a#x', strict).href).toBe('https://example.com/a#x');
  });
});

describe('loopback allow-list (development, tests and batch fixtures only)', () => {
  const policy = createNetworkPolicy({ loopbackHosts: ['127.0.0.1:8099', 'localhost:9000'] });

  it('permits exactly the listed host:port pairs', () => {
    expect(codeOf(() => validateUrl('http://127.0.0.1:8099/acme/', policy))).toBe('NO_ERROR');
    expect(codeOf(() => validateUrl('http://localhost:9000/', policy))).toBe('NO_ERROR');
  });

  it('still blocks other loopback ports and hosts', () => {
    expect(codeOf(() => validateUrl('http://127.0.0.1:8100/', policy))).toBe('INVALID_URL'); // port
    expect(codeOf(() => validateUrl('http://127.0.0.2:8099/', policy))).toBe('INVALID_URL');
    expect(codeOf(() => validateUrl('http://[::1]:8099/', policy))).toBe('INVALID_URL');
  });

  it('never unlocks private ranges or metadata endpoints', () => {
    expect(codeOf(() => validateUrl('http://10.0.0.1:8099/', policy))).toBe('INVALID_URL');
    expect(codeOf(() => validateUrl('http://169.254.169.254/', policy))).toBe('BLOCKED_ADDRESS');
    const withPrivate = createNetworkPolicy({ loopbackHosts: ['10.0.0.1:8099'] });
    expect(codeOf(() => validateUrl('http://10.0.0.1:8099/', withPrivate))).toBe('BLOCKED_ADDRESS');
  });

  it('refuses to be created in production', () => {
    expect(() =>
      createNetworkPolicy({ loopbackHosts: ['127.0.0.1:8099'], nodeEnv: 'production' }),
    ).toThrow(/production/i);
    expect(() => createNetworkPolicy({ nodeEnv: 'production' })).not.toThrow();
  });
});

describe('checkResolvedAddresses', () => {
  const url = new URL('https://company.example/');

  it('accepts public addresses', () => {
    expect(() =>
      checkResolvedAddresses(url, ['93.184.216.34', '2606:4700:4700::1111'], strict),
    ).not.toThrow();
  });

  it('rejects when ANY resolved address is not public', () => {
    expect(codeOf(() => checkResolvedAddresses(url, ['93.184.216.34', '10.0.0.5'], strict))).toBe(
      'BLOCKED_ADDRESS',
    );
    expect(codeOf(() => checkResolvedAddresses(url, ['127.0.0.1'], strict))).toBe(
      'BLOCKED_ADDRESS',
    );
    expect(codeOf(() => checkResolvedAddresses(url, ['::ffff:169.254.169.254'], strict))).toBe(
      'BLOCKED_ADDRESS',
    );
  });

  it('treats an empty or invalid answer as a DNS failure / blocked', () => {
    expect(codeOf(() => checkResolvedAddresses(url, [], strict))).toBe('DNS_FAILED');
    expect(codeOf(() => checkResolvedAddresses(url, ['not-an-ip'], strict))).toBe(
      'BLOCKED_ADDRESS',
    );
  });

  it('allows loopback only for an allow-listed host:port', () => {
    const fixture = new URL('http://fixture.test:8099/');
    const policy = createNetworkPolicy({ loopbackHosts: ['fixture.test:8099'] });
    expect(() => checkResolvedAddresses(fixture, ['127.0.0.1'], policy)).not.toThrow();
    expect(codeOf(() => checkResolvedAddresses(fixture, ['10.0.0.1'], policy))).toBe(
      'BLOCKED_ADDRESS',
    );
    expect(
      codeOf(() =>
        checkResolvedAddresses(new URL('http://other.test:8099/'), ['127.0.0.1'], policy),
      ),
    ).toBe('BLOCKED_ADDRESS');
  });

  it('does not put the resolved address in the error message', () => {
    try {
      checkResolvedAddresses(url, ['10.99.88.77'], strict);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('10.99.88.77');
    }
  });
});

describe('hostKey', () => {
  it('includes the effective port', () => {
    expect(hostKey(new URL('http://a.test/'))).toBe('a.test:80');
    expect(hostKey(new URL('https://a.test/'))).toBe('a.test:443');
    expect(hostKey(new URL('http://a.test:8099/'))).toBe('a.test:8099');
    expect(hostKey(new URL('http://[::1]:8099/'))).toBe('[::1]:8099');
  });
});
