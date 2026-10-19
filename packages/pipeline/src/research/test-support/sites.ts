import { html, redirect, text, type RouteHandler, type RouteResponse } from './site-server.js';

/** Deterministic fixture websites. Links are relative so the same site works on any host:port. */

type NavLink = [href: string, label: string];

export function page(opts: {
  title: string;
  h1?: string;
  body?: string;
  nav?: NavLink[];
  footer?: NavLink[];
  head?: string;
}): RouteResponse {
  const a = ([href, label]: NavLink) => `<a href="${href}">${label}</a>`;
  return html(`<!doctype html><html lang="en"><head><title>${opts.title}</title>${opts.head ?? ''}</head><body>
    <header><nav>${(opts.nav ?? []).map(a).join(' ')}</nav></header>
    <main><h1>${opts.h1 ?? opts.title}</h1>${opts.body ?? ''}</main>
    <footer>${(opts.footer ?? []).map(a).join(' ')}</footer></body></html>`);
}

const ABOUT_TEXT = `<p>Acme builds reusable rockets for small satellites. Our mission is cheap, reliable access to orbit
  for everyone who needs it, and we write all of our flight software in Rust.</p>`;

/** A conventional company: /careers linked from the navigation, an about page, a job detail page. */
export function conventionalSite(): Record<string, RouteHandler> {
  const nav: NavLink[] = [
    ['/about', 'About'],
    ['/careers', 'Careers'],
    ['/pricing', 'Pricing'],
    ['/blog', 'Blog'],
  ];
  const footer: NavLink[] = [
    ['/privacy', 'Privacy'],
    ['/login', 'Log in'],
    ['/logo.png', 'Logo'],
  ];
  return {
    '/robots.txt': text('User-agent: *\nDisallow: /admin/\n'),
    '/': page({
      title: 'Acme Rockets: reusable launch vehicles',
      h1: 'Acme Rockets',
      body: ABOUT_TEXT,
      nav,
      footer,
    }),
    '/about': page({ title: 'About Acme', h1: 'About us', body: ABOUT_TEXT, nav, footer }),
    '/careers': page({
      title: 'Careers at Acme',
      h1: 'Join our team',
      body: `<p>We are hiring engineers across the company. Browse our open positions below and apply now.</p>
        <ul><li><a href="/careers/backend-engineer">Backend Engineer</a> — Remote, full-time</li></ul>
        <p>Acme is an equal opportunity employer.</p>`,
      nav,
      footer,
    }),
    '/careers/backend-engineer': page({
      title: 'Backend Engineer | Acme Careers',
      h1: 'Backend Engineer',
      body: '<p>You will build the telemetry APIs that every launch depends on. Apply now to join the avionics group.</p>',
      nav,
      footer,
    }),
    '/pricing': page({
      title: 'Pricing',
      body: '<p>Launch prices start at a fixed rate per kilogram to low earth orbit.</p>',
      nav,
      footer,
    }),
    '/blog': page({
      title: 'Acme blog',
      body: '<p>Release notes and launch retrospectives from the flight software team.</p>',
      nav,
      footer,
    }),
    '/privacy': page({
      title: 'Privacy policy',
      body: '<p>We respect your privacy and keep only what we need.</p>',
      nav,
      footer,
    }),
    '/login': page({
      title: 'Log in',
      body: '<p>Sign in to the customer portal.</p>',
      nav,
      footer,
    }),
  };
}

const PROCESS_TEXT = `<p>Every candidate starts with a 30 minute recruiter screen.</p>
  <p>Next comes a take-home project that should take about four hours.</p>
  <p>The final stage is a system design interview followed by a values conversation.</p>`;

/** The hiring process lives in a handbook, behind non-standard paths and anchor text. */
export function nonstandardSite(): Record<string, RouteHandler> {
  const nav: NavLink[] = [
    ['/product', 'Product'],
    ['/pricing', 'Pricing'],
  ];
  const footer: NavLink[] = [['/handbook/', 'Handbook']];
  return {
    '/robots.txt': text('User-agent: *\nAllow: /\n'),
    '/': page({
      title: 'Globex: open source analytics',
      h1: 'Globex',
      body: ABOUT_TEXT,
      nav,
      footer,
    }),
    '/product': page({
      title: 'Product',
      body: '<p>Globex is an analytics platform that you can host yourself.</p>',
      nav,
      footer,
    }),
    '/pricing': page({
      title: 'Pricing',
      body: '<p>Self-hosting is free. The cloud edition is billed per event.</p>',
      nav,
      footer,
    }),
    '/handbook/': page({
      title: 'Globex handbook',
      body: `<p>This handbook describes how the company works, in public.</p>
        <ul><li><a href="/handbook/people-group/talent-acquisition">How we hire</a></li>
        <li><a href="/handbook/engineering/">Engineering handbook</a></li></ul>`,
      nav,
      footer,
    }),
    '/handbook/people-group/talent-acquisition': page({
      title: 'How we hire | Globex Handbook',
      h1: 'Our interview process',
      body: PROCESS_TEXT,
      nav,
      footer,
    }),
    '/handbook/engineering/': page({
      title: 'Engineering handbook',
      body: '<p>Code review, testing and release practices for every engineer.</p>',
      nav,
      footer,
    }),
  };
}

/** A company site with no hiring or careers content anywhere on it. */
export function noHiringSite(): Record<string, RouteHandler> {
  const nav: NavLink[] = [
    ['/about', 'About'],
    ['/product', 'Product'],
    ['/contact', 'Contact'],
  ];
  return {
    '/robots.txt': { status: 404, body: 'Not found' },
    '/': page({
      title: 'Initech',
      h1: 'Initech',
      body: '<p>Initech makes software that processes TPS reports for large enterprises.</p>',
      nav,
    }),
    '/about': page({
      title: 'About Initech',
      h1: 'About us',
      body: '<p>Initech was founded in 1999 and builds back-office software for enterprise customers.</p>',
      nav,
    }),
    '/product': page({
      title: 'Product',
      body: '<p>Our product automates report processing end to end for finance departments.</p>',
      nav,
    }),
    '/contact': page({
      title: 'Contact',
      body: '<p>Write to sales at the address on this page for a quote.</p>',
      nav,
    }),
  };
}

/** A site served from a sub-path (like http://localhost:8099/acme/) using purely relative links. */
export function relativeLinkSite(prefix = '/acme'): Record<string, RouteHandler> {
  return {
    [`${prefix}/robots.txt`]: { status: 404, body: '' },
    [`${prefix}/`]: page({
      title: 'Acme (relative)',
      body: ABOUT_TEXT,
      nav: [
        ['careers/', 'Careers'],
        ['about.html', 'About us'],
        ['../acme/team', 'Team'],
      ],
    }),
    [`${prefix}/careers/`]: page({
      title: 'Careers at Acme',
      h1: 'Join our team',
      body: `<p>We are hiring engineers. See our open positions and apply now.</p>
        <a href="openings/backend">Backend Engineer, full-time</a>`,
    }),
    [`${prefix}/careers/openings/backend`]: page({
      title: 'Backend Engineer',
      body: '<p>Build the APIs behind every launch. Apply now.</p>',
    }),
    [`${prefix}/about.html`]: page({ title: 'About Acme', h1: 'About us', body: ABOUT_TEXT }),
    [`${prefix}/team`]: page({
      title: 'Team',
      body: '<p>Meet the small team behind the flight software and avionics.</p>',
    }),
  };
}

export { redirect };
