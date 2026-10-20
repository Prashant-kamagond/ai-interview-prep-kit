import {
  MAX_DAYS,
  MIN_DAYS,
  generationRequestSchema,
  type GenerationRequest,
} from '@trao/contracts';
import { ApiError } from '../../lib/api/client';

export type CreateField = 'jd' | 'company_url' | 'days';
export type CreateErrors = Partial<Record<CreateField, string>>;

export interface CreateValues {
  jd: string;
  company_url: string;
  /** Kept as typed so "abc" or "1.5" can be explained instead of silently becoming a number. */
  days: string;
}

export type CreateCheck =
  { ok: true; request: GenerationRequest } | { ok: false; errors: CreateErrors };

const MESSAGES: Record<CreateField, string> = {
  jd: 'Paste the job description.',
  company_url: 'Enter the company website as a full address, for example https://example.com.',
  days: `Enter a whole number of days from ${MIN_DAYS} to ${MAX_DAYS}.`,
};

function field(value: unknown): CreateField | null {
  return value === 'jd' || value === 'company_url' || value === 'days' ? value : null;
}

/** Checks the form with the API's own request schema, so browser and server cannot disagree. */
export function validateCreateForm(values: CreateValues): CreateCheck {
  const days = values.days.trim();
  const errors: CreateErrors = {};
  // Number('') is 0 and Number('1e1') is 10: accept only plain digits.
  const parsedDays = /^\d{1,3}$/.test(days) ? Number(days) : NaN;

  const parsed = generationRequestSchema.safeParse({
    jd: values.jd,
    company_url: values.company_url,
    days: parsedDays,
  });
  if (parsed.success) return { ok: true, request: parsed.data };

  for (const issue of parsed.error.issues) {
    const name = field(issue.path[0]);
    if (!name || errors[name]) continue;
    errors[name] =
      name === 'jd' && issue.code === 'too_big'
        ? 'The job description is too long (50,000 characters at most).'
        : MESSAGES[name];
  }
  return { ok: false, errors };
}

export interface SubmitFailure {
  form?: string;
  fields: CreateErrors;
}

/** What to show when the request to start a job fails. Unexpected errors never show their own text. */
export function describeSubmitError(error: unknown): SubmitFailure {
  if (error instanceof ApiError) {
    if (error.code === 'VALIDATION_ERROR' && Array.isArray(error.details)) {
      const fields: CreateErrors = {};
      for (const d of error.details as { path?: unknown }[]) {
        const name = field(typeof d?.path === 'string' ? d.path.split('.')[0] : undefined);
        if (name) fields[name] = MESSAGES[name];
      }
      if (Object.keys(fields).length > 0) return { fields };
    }
    if (error.code === 'RATE_LIMITED' || error.status === 429) {
      return { form: 'Too many requests. Wait a moment and try again.', fields: {} };
    }
    if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT') {
      return { form: error.message, fields: {} };
    }
    if (error.status >= 500) {
      return { form: 'The server had a problem. Please try again in a moment.', fields: {} };
    }
    return { form: error.message, fields: {} };
  }
  return { form: 'Something went wrong. Please try again.', fields: {} };
}
