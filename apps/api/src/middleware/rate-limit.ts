import { rateLimit } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { AppError } from '../errors.js';

/**
 * In-memory, per-IP limiter. That is deliberately simple: it needs no extra infrastructure, but
 * counters are per process and reset on restart, so with several instances the effective limit
 * is multiplied. Behind a proxy set TRUST_PROXY so the client IP, not the proxy's, is counted.
 */
export function createLimiter(limit: number, windowMs: number): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Please wait a moment and retry.')),
  });
}
