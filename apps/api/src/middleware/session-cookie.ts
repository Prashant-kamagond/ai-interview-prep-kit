import type { CookieOptions, Response } from 'express';
import type { Config } from '../config.js';

/**
 * In production the cookie is `__Host-` prefixed, which browsers only accept when it is Secure,
 * has Path=/ and carries no Domain attribute: it cannot be overwritten by a sibling subdomain.
 */
export function sessionCookieName(config: Pick<Config, 'isProduction'>): string {
  return config.isProduction ? '__Host-sid' : 'sid';
}

function baseOptions(config: Pick<Config, 'isProduction' | 'cookieSameSite'>): CookieOptions {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: config.cookieSameSite,
    path: '/',
  };
}

export function setSessionCookie(
  res: Response,
  config: Pick<Config, 'isProduction' | 'cookieSameSite'>,
  token: string,
  expires: Date,
): void {
  res.cookie(sessionCookieName(config), token, { ...baseOptions(config), expires });
}

export function clearSessionCookie(
  res: Response,
  config: Pick<Config, 'isProduction' | 'cookieSameSite'>,
): void {
  res.clearCookie(sessionCookieName(config), baseOptions(config));
}
