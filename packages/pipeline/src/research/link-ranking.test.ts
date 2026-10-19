import { describe, expect, it } from 'vitest';
import type { ExtractedLink } from './html.js';
import { rankLinks, scoreLink } from './link-ranking.js';

function link(href: string, text = '', extra: Partial<ExtractedLink> = {}): ExtractedLink {
  return {
    url: new URL(href, 'https://acme.test/'),
    text,
    title: '',
    nofollow: false,
    context: 'other',
    surrounding: '',
    ...extra,
  };
}

describe('scoreLink: hiring signals', () => {
  it.each([
    ['conventional /careers', link('/careers', 'Careers')],
    ['/jobs by path alone', link('/jobs', '')],
    ['"Join us" anchor on an opaque path', link('/p/8812', 'Join us')],
    ['"Work with us"', link('/x', 'Work with us')],
    ['"We\'re hiring"', link('/x', "We're hiring!")],
    ['opportunities', link('/opportunities', 'Opportunities')],
    ['recruitment path', link('/recruitment', '')],
    ['how we hire in a handbook', link('/handbook/people-group/talent-acquisition', 'How we hire')],
    ['interview process page', link('/engineering/interviews', 'Our interview process')],
    ['title attribute only', link('/x', 'icon', { title: 'Open positions' })],
    ['"Come build with us"', link('/crew', 'Come build with us')],
    ['hyphenated join-us path', link('/join-us', '')],
  ])('scores %s as a strong hiring candidate', (_name, l) => {
    expect(scoreLink(l).hiringScore).toBeGreaterThanOrEqual(5);
  });

  it('scores unrelated links near zero', () => {
    for (const l of [
      link('/pricing', 'Pricing'),
      link('/blog/release-notes', 'Release notes'),
      link('/contact', 'Contact'),
    ]) {
      expect(scoreLink(l).hiringScore).toBeLessThan(2);
    }
  });

  it('ranks "How we hire" above a generic engineering-blog link, but still values the blog a little', () => {
    const hire = scoreLink(link('/handbook/hiring', 'How we hire')).score;
    const blog = scoreLink(link('/blog', 'Engineering blog')).score;
    const noise = scoreLink(link('/pricing', 'Pricing')).score;
    expect(hire).toBeGreaterThan(blog);
    expect(blog).toBeGreaterThan(noise);
  });

  it('gives navigation and footer placement a small boost', () => {
    const plain = scoreLink(link('/team', 'Team')).score;
    expect(scoreLink(link('/team', 'Team', { context: 'nav' })).score).toBeGreaterThan(plain);
    expect(scoreLink(link('/team', 'Team', { context: 'footer' })).score).toBeGreaterThan(plain);
  });

  it('records human-readable reasons', () => {
    const { reasons } = scoreLink(link('/careers', 'Careers'));
    expect(reasons.join(' ')).toMatch(/anchor/i);
    expect(reasons.join(' ')).toMatch(/path/i);
  });

  it('does not mistake substrings for words (e.g. "carpet" is not "career")', () => {
    expect(scoreLink(link('/carpet-store', 'Carpet')).hiringScore).toBe(0);
    expect(scoreLink(link('/jobsite-safety', 'Jobsite safety')).hiringScore).toBeLessThan(2);
  });
});

describe('scoreLink: about and noise', () => {
  it('recognises company-description pages', () => {
    expect(scoreLink(link('/about', 'About us')).aboutScore).toBeGreaterThanOrEqual(4);
    expect(scoreLink(link('/company', 'Who we are')).aboutScore).toBeGreaterThanOrEqual(4);
    expect(scoreLink(link('/what-we-do', 'What we do')).aboutScore).toBeGreaterThanOrEqual(4);
  });

  it('pushes legal and policy pages below anything worth fetching', () => {
    for (const l of [
      link('/privacy', 'Privacy policy'),
      link('/terms', 'Terms of service'),
      link('/cookies', 'Cookies'),
    ]) {
      expect(scoreLink(l).score).toBeLessThanOrEqual(0);
    }
  });
});

describe('rankLinks', () => {
  it('sorts by score, breaks ties by URL, and is deterministic', () => {
    const links = [
      link('/zeta', 'Team'),
      link('/careers', 'Careers'),
      link('/alpha', 'Team'),
      link('/about', 'About'),
    ];
    const a = rankLinks(links).map((r) => r.link.url.pathname);
    const b = rankLinks([...links].reverse()).map((r) => r.link.url.pathname);
    expect(a).toEqual(b);
    expect(a[0]).toBe('/careers');
    expect(a.indexOf('/alpha')).toBeLessThan(a.indexOf('/zeta')); // equal scores → alphabetical
  });

  it('keeps one entry per page, with the best score among duplicates', () => {
    const ranked = rankLinks([
      link('/jobs', 'Click here'),
      link('/jobs?utm_source=nav', 'Careers'),
      link('/jobs#top', 'Careers'),
      link('http://www.acme.test/jobs/', 'Careers'),
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.score).toBe(scoreLink(link('/jobs', 'Careers')).score);
  });

  it('drops links the crawler must never follow (assets, auth) and nofollow links', () => {
    const ranked = rankLinks([
      link('/careers.pdf', 'Careers'),
      link('/login', 'Careers login'),
      link('/jobs', 'Jobs', { nofollow: true }),
      link('/jobs/engineering', 'Engineering jobs'),
    ]);
    expect(ranked.map((r) => r.link.url.pathname)).toEqual(['/jobs/engineering']);
  });
});
