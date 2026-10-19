import { z } from 'zod';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  /** The single browser origin allowed by CORS and the CSRF origin check. */
  webOrigin: string;
  mongodbUri: string;
  sessionSecret: string;
  sessionTtlMs: number;
  cookieSameSite: 'lax' | 'strict' | 'none';
  trustProxy: number;
  authRateLimitMax: number;
  apiRateLimitMax: number;
  logLevel: string;
  /** Consumed by the research layer (Phase 4); validated here so production cannot enable it. */
  allowPrivateHosts: boolean;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.url().default('http://localhost:3000'),
  MONGODB_URI: z.string().min(1),
  SESSION_SECRET: z.string().min(1),
  SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(168),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  API_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  LOG_LEVEL: z.string().default('info'),
  ALLOW_PRIVATE_HOSTS: z.enum(['true', 'false']).default('false'),
});

const MIN_PRODUCTION_SECRET_LENGTH = 32;
const PLACEHOLDER_SECRET = /replace-with|change-me|placeholder|example/i;

/**
 * Parses and validates the environment. Error messages name the offending variables but never
 * include their values, so a misconfiguration cannot leak a secret into logs.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new ConfigError(`Invalid environment configuration: ${names.join(', ')}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';

  if (isProduction) {
    if (
      e.SESSION_SECRET.length < MIN_PRODUCTION_SECRET_LENGTH ||
      PLACEHOLDER_SECRET.test(e.SESSION_SECRET)
    ) {
      throw new ConfigError(
        `SESSION_SECRET must be a real random value of at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`,
      );
    }
    if (e.ALLOW_PRIVATE_HOSTS === 'true') {
      throw new ConfigError('ALLOW_PRIVATE_HOSTS must be false in production');
    }
  }
  if (e.COOKIE_SAMESITE === 'none' && !isProduction) {
    throw new ConfigError(
      'COOKIE_SAMESITE=none requires Secure cookies, which need production mode',
    );
  }

  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    webOrigin: new URL(e.WEB_ORIGIN).origin,
    mongodbUri: e.MONGODB_URI,
    sessionSecret: e.SESSION_SECRET,
    sessionTtlMs: e.SESSION_TTL_HOURS * 3_600_000,
    cookieSameSite: e.COOKIE_SAMESITE,
    trustProxy: e.TRUST_PROXY,
    authRateLimitMax: e.AUTH_RATE_LIMIT_MAX,
    apiRateLimitMax: e.API_RATE_LIMIT_MAX,
    logLevel: e.LOG_LEVEL,
    allowPrivateHosts: e.ALLOW_PRIVATE_HOSTS === 'true',
  };
}
