import pino, { type Logger } from 'pino';

export type { Logger };

/**
 * Structured JSON logs. Request bodies are never logged; these redactions are a second line of
 * defence in case a header or credential object is logged by mistake.
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: undefined,
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'headers.cookie',
        'headers.authorization',
        '*.password',
        '*.passwordHash',
        '*.sessionSecret',
        '*.mongodbUri',
      ],
      censor: '[redacted]',
    },
  });
}
