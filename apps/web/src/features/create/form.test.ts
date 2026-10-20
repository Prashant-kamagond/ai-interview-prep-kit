import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { describeSubmitError, validateCreateForm } from './form';

const GOOD = { jd: 'Backend engineer', company_url: 'https://example.com', days: '14' };

describe('validateCreateForm', () => {
  it('builds the exact request the API takes, with days as a number and text trimmed', () => {
    expect(
      validateCreateForm({
        jd: '  Backend engineer \n',
        company_url: ' https://example.com ',
        days: ' 14 ',
      }),
    ).toEqual({
      ok: true,
      request: { jd: 'Backend engineer', company_url: 'https://example.com', days: 14 },
    });
  });

  it.each([['1'], ['60'], ['07']])('accepts %s days', (days) => {
    expect(validateCreateForm({ ...GOOD, days }).ok).toBe(true);
  });

  it.each([[''], ['0'], ['61'], ['-1'], ['1.5'], ['abc'], ['1e1'], [' '], ['١٠'], ['1000']])(
    'rejects %j days with an explanation on the days field only',
    (days) => {
      const result = validateCreateForm({ ...GOOD, days });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(Object.keys(result.errors)).toEqual(['days']);
        expect(result.errors.days).toBe('Enter a whole number of days from 1 to 60.');
      }
    },
  );

  it('says what is missing, per field, in plain words', () => {
    const result = validateCreateForm({ jd: '  ', company_url: '', days: '' });
    expect(result).toEqual({
      ok: false,
      errors: {
        jd: 'Paste the job description.',
        company_url:
          'Enter the company website as a full address, for example https://example.com.',
        days: 'Enter a whole number of days from 1 to 60.',
      },
    });
  });

  it.each([['example.com'], ['ftp://example.com'], ['javascript:alert(1)'], ['https://']])(
    'rejects the company address %j',
    (company_url) => {
      const result = validateCreateForm({ ...GOOD, company_url });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.company_url).toMatch(/full address/);
    },
  );

  it('explains an over-long description specifically', () => {
    const result = validateCreateForm({ ...GOOD, jd: 'x'.repeat(50_001) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.jd).toMatch(/too long/);
  });

  it('accepts a two-line description (a thin kit is allowed)', () => {
    expect(validateCreateForm({ ...GOOD, jd: 'Engineer\nWanted' }).ok).toBe(true);
  });
});

describe('describeSubmitError', () => {
  it('maps server validation details to fields', () => {
    const failure = describeSubmitError(
      new ApiError(400, 'VALIDATION_ERROR', 'Invalid', [
        { path: 'days', message: 'x' },
        { path: 'company_url', message: 'y' },
      ]),
    );
    expect(Object.keys(failure.fields).sort()).toEqual(['company_url', 'days']);
    expect(failure.form).toBeUndefined();
  });

  it('falls back to the message when the details name no field', () => {
    expect(
      describeSubmitError(
        new ApiError(400, 'VALIDATION_ERROR', 'Invalid input', [{ path: 'other' }]),
      ),
    ).toEqual({
      form: 'Invalid input',
      fields: {},
    });
  });

  it('asks the user to wait when rate limited', () => {
    expect(describeSubmitError(new ApiError(429, 'RATE_LIMITED', 'x')).form).toMatch(
      /Wait a moment/,
    );
  });

  it('passes on the fixed network and timeout messages', () => {
    expect(
      describeSubmitError(new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server.')).form,
    ).toBe('Could not reach the server.');
    expect(describeSubmitError(new ApiError(0, 'TIMEOUT', 'Took too long.')).form).toBe(
      'Took too long.',
    );
  });

  it('does not show the text of a server error or of an unexpected exception', () => {
    expect(
      describeSubmitError(new ApiError(500, 'INTERNAL_ERROR', 'stack trace here')).form,
    ).not.toMatch(/stack/);
    const unexpected = describeSubmitError(new Error('mongodb://user:secret@host'));
    expect(unexpected.form).toBe('Something went wrong. Please try again.');
  });
});
