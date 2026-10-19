import { describe, expect, it } from 'vitest';
import { inferCompanyName } from './company-name.js';

const infer = (url: string, title = '', siteName: string | null = null) =>
  inferCompanyName(new URL(url), title || siteName !== null ? { title, siteName } : null);

describe('inferCompanyName', () => {
  it('prefers the declared site name', () => {
    expect(infer('https://acme.com/', 'Home', 'Acme Rockets')).toEqual({
      name: 'Acme Rockets',
      source: 'site-name',
    });
  });

  it('picks the brand from a title with separators, skipping generic segments', () => {
    expect(infer('https://acme.com/', 'Careers at Acme | Acme Rockets')?.name).toBe('Acme Rockets');
    expect(infer('https://acme.com/', 'Acme: reusable launch vehicles')?.name).toBe('Acme');
    expect(infer('https://acme.com/', 'Welcome | Home | Acme')?.name).toBe('Acme');
  });

  it('takes the first non-generic segment when none matches the domain', () => {
    expect(infer('https://example.org/', 'Globex: open source analytics')).toEqual({
      name: 'Globex',
      source: 'title',
    });
  });

  it('uses a single-word title that is not generic', () => {
    expect(infer('http://127.0.0.1:8099/', 'Initech')?.name).toBe('Initech');
  });

  it('falls back to the domain name when the title says nothing', () => {
    expect(infer('https://www.acme.com/', 'Home')).toEqual({ name: 'Acme', source: 'hostname' });
    expect(infer('https://www.acme-rockets.co.uk/', '')).toEqual({
      name: 'Acme Rockets',
      source: 'hostname',
    });
    expect(infer('https://rockets.acme.io/', 'Welcome')?.name).toBe('Acme'); // the registrable domain, not the subdomain
  });

  it('uses the first path segment for local or IP roots', () => {
    expect(inferCompanyName(new URL('http://localhost:8099/acme/'), null)).toEqual({
      name: 'Acme',
      source: 'path',
    });
    expect(
      inferCompanyName(new URL('http://127.0.0.1:8099/globex-corp/'), {
        title: 'Home',
        siteName: null,
      }),
    ).toEqual({
      name: 'Globex Corp',
      source: 'path',
    });
  });

  it('returns null rather than inventing a name', () => {
    expect(inferCompanyName(new URL('http://127.0.0.1:8099/'), null)).toBeNull();
    expect(
      inferCompanyName(new URL('http://localhost/'), { title: 'Home', siteName: null }),
    ).toBeNull();
  });

  it('never returns an empty or overlong name', () => {
    const r = inferCompanyName(new URL('https://acme.com/'), {
      title: 'A'.repeat(300),
      siteName: null,
    });
    expect(r?.name.length).toBeGreaterThan(0);
    expect(r!.name.length).toBeLessThanOrEqual(80);
  });
});
