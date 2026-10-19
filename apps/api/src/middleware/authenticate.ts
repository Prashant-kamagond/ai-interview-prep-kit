import type { RequestHandler } from 'express';
import type { Config } from '../config.js';
import { AppError, unauthenticated } from '../errors.js';
import { isWellFormedToken } from '../security/session-token.js';
import type { AuthService } from '../services/auth.js';
import { clearSessionCookie, sessionCookieName } from './session-cookie.js';

/** Rejects the request with 401 unless it carries a valid, unexpired session cookie. */
export function requireAuth(
  auth: AuthService,
  config: Pick<Config, 'isProduction' | 'cookieSameSite'>,
): RequestHandler {
  const cookieName = sessionCookieName(config);

  return async (req, res, next) => {
    try {
      const token: unknown = req.cookies?.[cookieName];
      if (!isWellFormedToken(token)) throw unauthenticated();
      req.user = await auth.authenticate(token);
      next();
    } catch (err) {
      // A cookie that is no longer valid is useless; tell the browser to drop it.
      if (err instanceof AppError && err.status === 401) clearSessionCookie(res, config);
      next(err);
    }
  };
}
