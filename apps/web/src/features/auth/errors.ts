import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@trao/contracts';
import { ApiError } from '../../lib/api/client';

export type AuthMode = 'login' | 'register';
export type FieldName = 'email' | 'password';
export type FieldErrors = Partial<Record<FieldName, string>>;

export interface AuthFailure {
  /** A problem with the attempt as a whole (wrong password, server down ...). */
  form?: string;
  fields: FieldErrors;
}

/** Our own wording for each field, so users never see validator jargon such as "expected string". */
export function fieldMessage(field: FieldName, mode: AuthMode): string {
  if (field === 'email') return 'Enter a valid email address.';
  return mode === 'register'
    ? `Use ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters for your password.`
    : 'Enter your password.';
}

function isField(value: unknown): value is FieldName {
  return value === 'email' || value === 'password';
}

/** Field errors from a validator's issue list (the first issue per field wins). */
export function fieldErrorsFromIssues(
  issues: readonly { path: readonly PropertyKey[] }[],
  mode: AuthMode,
): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const field = issue.path[0];
    if (isField(field) && errors[field] === undefined) errors[field] = fieldMessage(field, mode);
  }
  return errors;
}

/** Turns anything that went wrong while signing in or registering into text the form can show. */
export function describeAuthError(error: unknown, mode: AuthMode): AuthFailure {
  if (!(error instanceof ApiError)) {
    return { fields: {}, form: 'Something went wrong. Please try again.' };
  }
  switch (error.code) {
    case 'INVALID_CREDENTIALS':
      return { fields: {}, form: 'Email or password is incorrect.' };
    case 'EMAIL_TAKEN':
      return { fields: { email: 'An account with this email already exists. Try signing in.' } };
    case 'RATE_LIMITED':
      return { fields: {}, form: 'Too many attempts. Wait a few minutes before trying again.' };
    case 'VALIDATION_ERROR': {
      const details = Array.isArray(error.details) ? error.details : [];
      const issues = details
        .map((d) => (d && typeof d === 'object' ? (d as { path?: unknown }).path : undefined))
        .filter((p): p is string => typeof p === 'string')
        .map((p) => ({ path: p.split('.') }));
      const fields = fieldErrorsFromIssues(issues, mode);
      return Object.keys(fields).length > 0
        ? { fields }
        : { fields: {}, form: 'Check the details you entered and try again.' };
    }
    default:
      // Server messages are curated; network and timeout messages are fixed sentences.
      return { fields: {}, form: error.message };
  }
}
