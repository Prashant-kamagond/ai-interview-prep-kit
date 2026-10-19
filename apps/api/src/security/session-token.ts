import { createHmac, randomBytes } from 'node:crypto';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

/** An opaque 256-bit identifier. It carries no data and cannot be derived or guessed. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isWellFormedToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

/**
 * The database stores only this keyed hash. Reading the sessions collection therefore does not
 * give an attacker usable cookies, and rotating SESSION_SECRET invalidates every session.
 */
export function hashSessionToken(secret: string, token: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}
