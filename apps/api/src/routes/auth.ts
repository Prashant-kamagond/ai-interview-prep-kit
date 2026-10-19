import { Router, type RequestHandler } from 'express';
import { loginSchema, registerSchema } from '@trao/contracts';
import type { Config } from '../config.js';
import {
  clearSessionCookie,
  sessionCookieName,
  setSessionCookie,
} from '../middleware/session-cookie.js';
import { isWellFormedToken } from '../security/session-token.js';
import type { AuthService } from '../services/auth.js';

export function authRouter(deps: {
  auth: AuthService;
  config: Config;
  credentialLimiter: RequestHandler;
  requireAuth: RequestHandler;
}): Router {
  const { auth, config, credentialLimiter, requireAuth } = deps;
  const router = Router();

  router.post('/auth/register', credentialLimiter, async (req, res) => {
    const session = await auth.register(registerSchema.parse(req.body ?? {}));
    setSessionCookie(res, config, session.token, session.expiresAt);
    res.status(201).json({ user: session.user });
  });

  router.post('/auth/login', credentialLimiter, async (req, res) => {
    const session = await auth.login(loginSchema.parse(req.body ?? {}));
    setSessionCookie(res, config, session.token, session.expiresAt);
    res.json({ user: session.user });
  });

  // Idempotent: always succeeds and always clears the cookie, even without a valid session.
  router.post('/auth/logout', async (req, res) => {
    const token: unknown = req.cookies?.[sessionCookieName(config)];
    if (isWellFormedToken(token)) await auth.logout(token);
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  router.get('/auth/me', requireAuth, (req, res) => {
    const { id, email } = req.user!;
    res.json({ user: { id, email } });
  });

  return router;
}
