import type { RequestHandler } from 'express';
import { AppError } from '../errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated, state-changing requests: the Origin header must match
 * the configured web origin exactly. Browsers always send Origin on cross-origin POST/PUT/DELETE
 * and attackers cannot forge it, so a request from another site is rejected before it reaches a
 * handler. Requests with no Origin are rejected too: this API is used by the web app only, and
 * non-browser clients (the batch CLI) call the pipeline directly rather than this API.
 *
 * Complements SameSite cookies and the JSON-only body parser. Limitation: it relies on the
 * browser's Origin header, which every current browser sends on these requests.
 */
export function originCheck(allowedOrigin: string): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (req.get('origin') !== allowedOrigin) {
      return next(new AppError(403, 'CSRF_ORIGIN_REJECTED', 'Cross-origin request rejected'));
    }
    next();
  };
}
