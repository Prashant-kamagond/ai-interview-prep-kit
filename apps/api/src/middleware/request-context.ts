import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Logger } from '../logger.js';

const SAFE_REQUEST_ID = /^[\w-]{8,64}$/;

/**
 * Assigns a correlation id and logs one line per request. Only method, path (no query string),
 * status and duration are logged: never headers, cookies or bodies.
 */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const inbound = req.get('x-request-id');
    req.id = inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
    res.setHeader('X-Request-Id', req.id);

    const started = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info(
        {
          requestId: req.id,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        },
        'request',
      );
    });
    next();
  };
}
