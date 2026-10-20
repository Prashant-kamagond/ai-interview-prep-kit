import { describe, expect, it } from 'vitest';
import {
  MAX_BATCH_CASES,
  parseBatchFile,
  readyRows,
  rowLabel,
  summarizeBatch,
  type BatchParse,
} from './batch-input';

const good = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  jd: 'Senior Backend Engineer\n\nWe are looking for someone.',
  company_url: 'https://example.com',
  days: 7,
  ...over,
});

const parse = (value: unknown) => parseBatchFile(JSON.stringify(value));
function rowsOf(result: BatchParse) {
  if (!result.ok) throw new Error(`expected rows, got file error: ${result.fileError}`);
  return result.rows;
}

describe('file-level problems (the file cannot be used at all)', () => {
  it.each([
    ['empty file', '', /empty/i],
    ['only whitespace', '  \n ', /empty/i],
    ['not JSON', '{"id": "a",', /not valid JSON/],
    ['plain text', 'hello', /not valid JSON/],
    ['a JSON object, not a list', '{"id":"a"}', /must contain a JSON list/],
    ['a JSON string', '"cases"', /must contain a JSON list/],
    ['null', 'null', /must contain a JSON list/],
    ['an empty list', '[]', /list is empty/],
  ])('%s', (_name, text, message) => {
    const result = parseBatchFile(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fileError).toMatch(message);
  });

  it('refuses more cases than the limit, saying how many there were', () => {
    const many = Array.from({ length: MAX_BATCH_CASES + 1 }, (_, i) => good(`c${i}`));
    const result = parse(many);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fileError).toContain(`${MAX_BATCH_CASES + 1} cases`);
    expect(parse(many.slice(0, MAX_BATCH_CASES)).ok).toBe(true);
  });

  it('accepts a file that starts with a byte-order mark', () => {
    const result = parseBatchFile(String.fromCharCode(0xfeff) + JSON.stringify([good('a')]));
    expect(rowsOf(result)[0]?.request).not.toBeNull();
  });
});

describe('a valid file', () => {
  it('keeps every id and the exact request fields for each case', () => {
    const rows = rowsOf(
      parse([good('case-01'), good('case-02', { days: 30, company_url: 'http://acme.test/' })]),
    );
    expect(rows.map((r) => r.id)).toEqual(['case-01', 'case-02']);
    expect(rows.every((r) => r.errors.length === 0)).toBe(true);
    expect(rows[1]?.request).toEqual({
      jd: 'Senior Backend Engineer\n\nWe are looking for someone.',
      company_url: 'http://acme.test/',
      days: 30,
    });
    expect(summarizeBatch(rows)).toEqual({ valid: 2, invalid: 0 });
  });

  it('numbers entries from 1, as a person counts them', () => {
    expect(rowsOf(parse([good('a'), good('b')])).map((r) => r.position)).toEqual([1, 2]);
  });

  it('ignores extra keys instead of sending them on', () => {
    const rows = rowsOf(parse([good('a', { extra: 'x', admin: true })]));
    expect(rows[0]?.request).toEqual({
      jd: expect.any(String),
      company_url: 'https://example.com',
      days: 7,
    });
  });
});

describe('per-case problems (the other cases are unaffected)', () => {
  it('reports each case on its own row and never drops one', () => {
    const rows = rowsOf(
      parse([
        good('ok-1'),
        good('bad-days', { days: 0 }),
        good('ok-2'),
        good('bad-url', { company_url: 'not a url' }),
      ]),
    );
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.request !== null)).toEqual([true, false, true, false]);
    expect(rows[1]?.errors).toEqual(['days must be a whole number from 1 to 60.']);
    expect(rows[3]?.errors).toEqual([
      'company_url must be a full http:// or https:// web address.',
    ]);
    expect(summarizeBatch(rows)).toEqual({ valid: 2, invalid: 2 });
    // Only the valid cases would ever be submitted, with their own ids.
    expect(readyRows(rows).map((r) => r.id)).toEqual(['ok-1', 'ok-2']);
  });

  it('lists every problem in one case', () => {
    const rows = rowsOf(parse([{ id: 'x', jd: '   ', company_url: 'ftp://x', days: 2.5 }]));
    expect(rows[0]?.errors).toHaveLength(3);
    expect(rows[0]?.errors.join(' ')).toMatch(/jd.*company_url.*days/s);
  });

  it('rejects days above the API limit, which the file format alone would allow', () => {
    const [row] = rowsOf(parse([good('long', { days: 61 })]));
    expect(row?.request).toBeNull();
    expect(row?.errors).toEqual(['days must be a whole number from 1 to 60.']);
  });

  it.each([
    ['days as text', { days: '7' }, 'days'],
    ['days as a decimal', { days: 7.5 }, 'days'],
    ['negative days', { days: -3 }, 'days'],
    ['missing days', { days: undefined }, 'days'],
    ['missing jd', { jd: undefined }, 'jd'],
    ['blank jd', { jd: '  \n ' }, 'jd'],
    ['jd that is not text', { jd: 42 }, 'jd'],
    ['too-long jd', { jd: 'x'.repeat(50_001) }, 'jd'],
    ['missing company_url', { company_url: undefined }, 'company_url'],
    ['javascript: address', { company_url: 'javascript:alert(1)' }, 'company_url'],
  ])('flags %s', (_name, over, field) => {
    const [row] = rowsOf(parse([good('a', over)]));
    expect(row?.request).toBeNull();
    expect(row?.errors.some((e) => e.startsWith(field))).toBe(true);
  });

  it('explains a missing or blank id, and labels such a case by its position', () => {
    const rows = rowsOf(
      parse([good('a', { id: undefined }), good('b', { id: '' }), good('c', { id: 7 })]),
    );
    for (const row of rows) {
      expect(row.request).toBeNull();
      expect(row.errors).toContain('id must be a non-empty text.');
      expect(row.id).toBeNull();
    }
    expect(rowLabel(rows[1]!)).toBe('Case 2');
  });

  it.each([[1], ['text'], [null], [[1, 2]]])(
    'flags an entry that is not an object (%j)',
    (entry) => {
      const [row] = rowsOf(parse([entry]));
      expect(row?.request).toBeNull();
      expect(row?.errors[0]).toMatch(/not an object/);
    },
  );

  it('flags every case that shares an id, and none of the others', () => {
    const rows = rowsOf(parse([good('dup'), good('solo'), good('dup', { days: 3 })]));
    expect(rows.map((r) => r.request !== null)).toEqual([false, true, false]);
    expect(rows[0]?.errors[0]).toMatch(/"dup" is used by more than one case/);
    expect(rows[2]?.errors[0]).toMatch(/"dup" is used by more than one case/);
    expect(rows[1]?.errors).toEqual([]);
  });

  it('never marks a partly invalid file as fully valid', () => {
    const rows = rowsOf(parse([good('a'), good('b', { days: 0 })]));
    expect(summarizeBatch(rows).invalid).toBe(1);
    expect(rows.every((r) => r.request !== null)).toBe(false);
  });

  it('does not let a hostile id reach the page as anything but text', () => {
    const [row] = rowsOf(parse([good('<img src=x onerror=alert(1)>', { days: 0 })]));
    expect(row?.id).toBe('<img src=x onerror=alert(1)>'); // rendered as text by React, never as HTML
  });
});
