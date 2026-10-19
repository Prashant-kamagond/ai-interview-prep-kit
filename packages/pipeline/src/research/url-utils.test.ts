import { describe, expect, it } from 'vitest';
import { createScope, crawlableLinkProblem, resolveLink, urlKey } from './url-utils.js';

describe('urlKey (dedupe key)', () => {
  it.each([
    ['https://Acme.com/Careers/', 'acme.com/Careers'],
    ['http://acme.com/careers', 'acme.com/careers'], // scheme ignored: http→https is the same page
    ['https://www.acme.com/careers', 'acme.com/careers'], // www ignored
    ['https://acme.com/careers#team', 'acme.com/careers'],
    ['https://acme.com/careers?utm_source=x&utm_medium=y', 'acme.com/careers'],
    ['https://acme.com/careers?fbclid=1&team=eng', 'acme.com/careers?team=eng'],
    ['https://acme.com/', 'acme.com/'],
    ['https://acme.com/index.html', 'acme.com/'],
    ['https://acme.com/jobs/index.html', 'acme.com/jobs'],
    ['https://acme.com:8443/a', 'acme.com:8443/a'],
    ['https://acme.com:443/a', 'acme.com/a'],
  ])('%s → %s', (input, expected) => {
    expect(urlKey(new URL(input))).toBe(expected);
  });
});

describe('resolveLink', () => {
  const base = new URL('https://acme.test/company/about/');

  it.each([
    ['/careers', 'https://acme.test/careers'],
    ['team', 'https://acme.test/company/about/team'],
    ['../jobs', 'https://acme.test/company/jobs'],
    ['./values', 'https://acme.test/company/about/values'],
    ['?tab=2', 'https://acme.test/company/about/?tab=2'],
    ['//cdn.other.test/x', 'https://cdn.other.test/x'],
    ['https://elsewhere.test/a', 'https://elsewhere.test/a'],
    ['  /spaced  ', 'https://acme.test/spaced'],
    ['/careers#open-roles', 'https://acme.test/careers#open-roles'],
  ])('resolves %s', (href, expected) => {
    expect(resolveLink(href, base)?.href).toBe(expected);
  });

  it.each([
    '',
    '#',
    '#top',
    'mailto:hr@acme.test',
    'tel:+123',
    'javascript:void(0)',
    'data:text/html,x',
    'ftp://x.test/',
    'http://',
  ])('drops %j', (href) => {
    expect(resolveLink(href, base)).toBeNull();
  });
});

describe('createScope (what the crawler may follow)', () => {
  it('keeps to the root host, treating www as the same site', () => {
    const scope = createScope(new URL('https://www.acme.com/'));
    expect(scope.contains(new URL('https://acme.com/careers'))).toBe(true);
    expect(scope.contains(new URL('https://www.acme.com/careers'))).toBe(true);
    expect(scope.contains(new URL('http://acme.com/careers'))).toBe(true);
  });

  it('follows subdomains of the root host, but not look-alikes or unrelated sites', () => {
    const scope = createScope(new URL('https://acme.com/'));
    expect(scope.contains(new URL('https://careers.acme.com/'))).toBe(true);
    expect(scope.contains(new URL('https://jobs.eu.acme.com/'))).toBe(true);
    expect(scope.contains(new URL('https://evilacme.com/'))).toBe(false);
    expect(scope.contains(new URL('https://acme.com.evil.test/'))).toBe(false);
    expect(scope.contains(new URL('https://linkedin.com/company/acme'))).toBe(false);
    expect(scope.contains(new URL('https://boards.greenhouse.io/acme'))).toBe(false);
  });

  it('does not climb from a subdomain to its parent or sideways to siblings', () => {
    const scope = createScope(new URL('https://blog.acme.com/'));
    expect(scope.contains(new URL('https://blog.acme.com/post'))).toBe(true);
    expect(scope.contains(new URL('https://acme.com/'))).toBe(false);
    expect(scope.contains(new URL('https://shop.acme.com/'))).toBe(false);
  });

  it('requires the root port (or the scheme default) for the same host', () => {
    const scope = createScope(new URL('http://127.0.0.1:8099/acme/'));
    expect(scope.contains(new URL('http://127.0.0.1:8099/acme/careers'))).toBe(true);
    expect(scope.contains(new URL('http://127.0.0.1:9000/'))).toBe(false);
    expect(scope.contains(new URL('http://127.0.0.1/'))).toBe(false);
  });

  it('treats IP-literal and localhost roots as exact-host only', () => {
    const scope = createScope(new URL('http://127.0.0.1:8099/'));
    expect(scope.contains(new URL('http://127.0.0.2:8099/'))).toBe(false);
    const local = createScope(new URL('http://localhost:8099/'));
    expect(local.contains(new URL('http://api.localhost:8099/'))).toBe(false);
  });

  it('rejects non-http schemes', () => {
    const scope = createScope(new URL('https://acme.com/'));
    expect(scope.contains(new URL('ftp://acme.com/'))).toBe(false);
  });
});

describe('crawlableLinkProblem', () => {
  const ok = (u: string) => crawlableLinkProblem(new URL(u));

  it.each([
    'https://acme.com/careers',
    'https://acme.com/about-us',
    'https://acme.com/handbook/hiring/interviewing',
    'https://acme.com/blog/how-we-interview',
    'https://acme.com/jobs?team=engineering',
    'https://acme.com/accounting-team', // contains "account" but is not an account page
  ])('allows %s', (u) => {
    expect(ok(u)).toBeNull();
  });

  it.each([
    ['https://acme.com/logo.png', 'asset'],
    ['https://acme.com/styles/site.css', 'asset'],
    ['https://acme.com/app.js', 'asset'],
    ['https://acme.com/files/handbook.pdf', 'asset'],
    ['https://acme.com/archive.zip', 'asset'],
    ['https://acme.com/video.mp4', 'asset'],
    ['https://acme.com/login', 'auth'],
    ['https://acme.com/users/sign-in', 'auth'],
    ['https://acme.com/signup', 'auth'],
    ['https://acme.com/logout', 'auth'],
    ['https://acme.com/account/settings', 'auth'],
    ['https://acme.com/wp-admin/', 'auth'],
    ['https://acme.com/oauth/authorize', 'auth'],
    ['https://acme.com/cart', 'auth'],
    ['https://acme.com/page?logout=1', 'auth'],
    ['https://acme.com/feed.xml', 'asset'],
  ])('rejects %s (%s)', (u, kind) => {
    expect(ok(u)).toBe(kind);
  });
});
