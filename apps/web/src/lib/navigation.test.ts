import { describe, expect, it } from 'vitest';
import { DEFAULT_LANDING, loginHref, safeNextPath } from './navigation';

describe('safeNextPath', () => {
  it.each(['/kits', '/kits/abc123', '/kits/abc?tab=schedule#q4', '/a/b/c'])(
    'accepts the in-app path %s',
    (path) => {
      expect(safeNextPath(path)).toBe(path);
    },
  );

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a full URL', 'https://evil.example/phish'],
    ['a protocol-relative URL', '//evil.example'],
    ['a backslash host', '/\\evil.example'],
    ['an encoded protocol-relative URL', '/%2Fevil.example'],
    ['an encoded double slash', '%2F%2Fevil.example'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a relative path without a leading slash', 'kits'],
    ['a path with a control character', '/kits\n/x'],
    ['a tab in the path', '/kits\t'],
    ['an encoded backslash', '/%5Cevil.example'],
    ['a scheme hidden after a slash', '/javascript:alert(1)'],
    ['a malformed escape', '/%E0%A4%A'],
    ['an over-long value', `/${'a'.repeat(600)}`],
  ])('falls back for %s', (_label, value) => {
    expect(safeNextPath(value as string | null | undefined)).toBe(DEFAULT_LANDING);
  });

  it('uses the fallback it is given', () => {
    expect(safeNextPath('https://evil.example', '/somewhere')).toBe('/somewhere');
  });
});

describe('loginHref', () => {
  it('goes to a plain sign-in page for the default landing or nothing', () => {
    expect(loginHref()).toBe('/login');
    expect(loginHref('/kits')).toBe('/login');
  });

  it('remembers a real destination, and drops an unsafe one', () => {
    expect(loginHref('/kits/abc')).toBe('/login?next=%2Fkits%2Fabc');
    expect(loginHref('https://evil.example')).toBe('/login');
  });

  it('adds extra flags such as an expired session', () => {
    expect(loginHref('/kits/abc', { expired: '1' })).toBe('/login?expired=1&next=%2Fkits%2Fabc');
    expect(loginHref(null, { expired: '1' })).toBe('/login?expired=1');
  });
});
