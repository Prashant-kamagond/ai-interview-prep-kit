/** An error that is safe to show to the client: its code, message and details are curated. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * Used for both "does not exist" and "belongs to someone else", so a caller cannot probe which
 * ids exist.
 */
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);

export const unauthenticated = (code = 'UNAUTHENTICATED', message = 'Authentication required') =>
  new AppError(401, code, message);

export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.';
