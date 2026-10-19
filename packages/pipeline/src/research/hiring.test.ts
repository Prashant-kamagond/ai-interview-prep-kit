import { describe, expect, it } from 'vitest';
import { extractPage } from './html.js';
import { classifyPage } from './hiring.js';

function classify(path: string, html: string) {
  const url = new URL(path, 'https://acme.test');
  const page = extractPage(html, url);
  return { page, result: classifyPage(url, page) };
}

const careers = `<html><head><title>Careers at Acme</title></head><body><main>
  <h1>Join our team</h1>
  <p>We are hiring engineers across the company. Browse our open positions below and apply now.</p>
  <ul><li>Backend Engineer — Remote, full-time</li><li>Designer — Berlin</li></ul>
  <p>Acme is an equal opportunity employer.</p></main></body></html>`;

const process = `<html><head><title>How we hire | Acme Handbook</title></head><body><main>
  <h1>Our interview process</h1>
  <p>Every candidate starts with a 30 minute recruiter screen.</p>
  <p>Next comes a take-home project that should take about four hours.</p>
  <p>The final stage is a system design interview followed by a values conversation.</p>
  </main></body></html>`;

const about = `<html><head><title>About Acme</title></head><body><main>
  <h1>About us</h1><p>Acme builds reusable rockets for small satellites. Our mission is cheap, reliable access to orbit for everyone who needs it.</p>
  </main></body></html>`;

const blog = `<html><head><title>Release notes 4.2</title></head><body><main>
  <h1>Release notes</h1><p>This release improves thruster calibration and fixes two telemetry bugs.</p></main></body></html>`;

describe('classifyPage', () => {
  it('recognises a careers listing as a hiring page', () => {
    const { result } = classify('/careers', careers);
    expect(result.role).toBe('hiring');
    expect(result.hiringScore).toBeGreaterThanOrEqual(6);
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it('recognises a page that describes the interview process, even on a non-standard path', () => {
    const { result } = classify('/handbook/people-group/talent-acquisition', process);
    expect(result.role).toBe('hiring-process');
    expect(result.interviewMentions.length).toBeGreaterThanOrEqual(2);
  });

  it('classifies about pages and unrelated pages without calling them hiring pages', () => {
    expect(classify('/about', about).result.role).toBe('about');
    expect(classify('/blog/release-4-2', blog).result.role).toBe('other');
    expect(classify('/blog/release-4-2', blog).result.hiringScore).toBeLessThan(3);
  });

  it('does not invent a hiring page from a thin or empty page', () => {
    expect(classify('/x', '').result.role).toBe('other');
    expect(classify('/x', '<p>Hello</p>').result.role).toBe('other');
  });

  it('quotes interview mentions verbatim from the page (grounded, never paraphrased)', () => {
    const { page, result } = classify('/handbook/hiring', process);
    expect(result.interviewMentions.length).toBeGreaterThan(0);
    for (const mention of result.interviewMentions) {
      expect(page.text).toContain(mention);
      expect(mention.length).toBeLessThanOrEqual(240);
    }
    expect(result.interviewMentions.join(' ')).toMatch(/take-home/);
  });

  it('caps the number of mentions', () => {
    const many = `<main>${'<p>The interview stage has a technical interview and a phone screen number X.</p>'.repeat(30)}</main>`;
    expect(classify('/i', many).result.interviewMentions.length).toBeLessThanOrEqual(5);
  });

  it('uses the URL as one signal among several', () => {
    const { result } = classify('/careers', '<main><p>Short page.</p></main>');
    expect(result.hiringScore).toBeGreaterThan(0);
    expect(result.role).not.toBe('hiring-process');
  });

  it('is deterministic', () => {
    expect(classify('/careers', careers).result).toEqual(classify('/careers', careers).result);
  });

  it('reports evidence as plain observations, not conclusions about the company', () => {
    const { result } = classify('/careers', careers);
    for (const line of result.evidence) expect(line).toMatch(/(title|heading|url|text)/i);
  });
});
