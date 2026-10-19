import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, GENERIC_ERROR_MESSAGE, notFound } from '../errors.js';
import type { Logger } from '../logger.js';

export const routeNotFound: RequestHandler = (_req, _res, next) => next(notFound('Route'));

function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((out, part) => {
    if (typeof part === 'number') return `${out}[${part}]`;
    return out === '' ? String(part) : `${out}.${String(part)}`;
  }, '');
}

/**
 * The single place errors become responses. Every response has the shape
 * `{ error: { code, message, details?, request_id } }`. Only curated errors (AppError, Zod
 * validation, body-parser failures) reach the client with their own text; everything else is
 * logged server-side and answered with a generic 500, so driver messages, hosts and stack traces
 * never leave the process.
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const send = (status: number, code: string, message: string, details?: unknown) => {
      res.status(status).json({
        error: { code, message, ...(details === undefined ? {} : { details }), request_id: req.id },
      });
    };

    if (err instanceof AppError) {
      send(err.status, err.code, err.message, err.details);
      return;
    }
    if (err instanceof ZodError) {
      send(
        400,
        'VALIDATION_ERROR',
        'Request validation failed',
        err.issues.map((i) => ({ path: formatPath(i.path), message: i.message })),
      );
      return;
    }

    // body-parser failures carry a stable `type`.
    switch ((err as { type?: unknown } | null)?.type) {
      case 'entity.too.large':
        send(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
        return;
      case 'entity.parse.failed':
        send(400, 'INVALID_JSON', 'Request body is not valid JSON');
        return;
      case 'charset.unsupported':
      case 'encoding.unsupported':
        send(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported request encoding');
        return;
    }

    logger.error({ err, requestId: req.id, method: req.method, path: req.path }, 'unhandled error');
    send(500, 'INTERNAL_ERROR', GENERIC_ERROR_MESSAGE);
  };
}
