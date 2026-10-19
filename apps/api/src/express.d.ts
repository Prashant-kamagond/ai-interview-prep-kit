import type { AuthenticatedUser } from './services/auth.js';

declare global {
  namespace Express {
    interface Request {
      /** Correlation id, echoed in the X-Request-Id header and in every error body. */
      id: string;
      /** Set by requireAuth. */
      user?: AuthenticatedUser;
    }
  }
}
