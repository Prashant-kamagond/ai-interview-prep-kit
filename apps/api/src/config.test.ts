import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const base = {
  MONGODB_URI: 'mongodb://localhost:27017/trao',
  SESSION_SECRET: 'dev-secret',
};

const strongSecret = 'x'.repeat(48);

describe('loadConfig', () => {
  it('applies safe development defaults', () => {
    const c = loadConfig(base);
    expect(c.nodeEnv).toBe('development');
    expect(c.isProduction).toBe(false);
    expect(c.port).toBe(4000);
    expect(c.webOrigin).toBe('http://localhost:3000');
    expect(c.cookieSameSite).toBe('lax');
    expect(c.allowPrivateHosts).toBe(false);
    expect(c.sessionTtlMs).toBe(168 * 3_600_000);
  });

  it('normalises WEB_ORIGIN to an origin without a trailing slash or path', () => {
    expect(
      loadConfig({ ...base, WEB_ORIGIN: 'https://app.example.com/some/path/' }).webOrigin,
    ).toBe('https://app.example.com');
  });

  it('requires MONGODB_URI and SESSION_SECRET', () => {
    expect(() => loadConfig({ SESSION_SECRET: 'a' })).toThrow(ConfigError);
    expect(() => loadConfig({ MONGODB_URI: 'mongodb://x' })).toThrow(ConfigError);
  });

  it('rejects a weak or placeholder session secret in production', () => {
    const prod = { ...base, NODE_ENV: 'production' };
    expect(() => loadConfig({ ...prod, SESSION_SECRET: 'short' })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...prod, SESSION_SECRET: 'replace-with-a-long-random-string-0123456789' }),
    ).toThrow(ConfigError);
    expect(loadConfig({ ...prod, SESSION_SECRET: strongSecret }).isProduction).toBe(true);
  });

  it('refuses to start in production with private-host fetching enabled', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        SESSION_SECRET: strongSecret,
        ALLOW_PRIVATE_HOSTS: 'true',
      }),
    ).toThrow(/ALLOW_PRIVATE_HOSTS/);
  });

  it('allows SameSite=None only in production (it requires Secure cookies)', () => {
    expect(() => loadConfig({ ...base, COOKIE_SAMESITE: 'none' })).toThrow(ConfigError);
    expect(
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        SESSION_SECRET: strongSecret,
        COOKIE_SAMESITE: 'none',
      }).cookieSameSite,
    ).toBe('none');
  });

  it('never echoes secret values in its error message', () => {
    try {
      loadConfig({ ...base, NODE_ENV: 'production', SESSION_SECRET: 'super-secret-value' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('super-secret-value');
    }
  });
});
