import type { ObjectId } from 'mongodb';
import type { LoginInput, RegisterInput } from '@trao/contracts';
import type { Config } from '../config.js';
import { isDuplicateKeyError } from '../db.js';
import { AppError } from '../errors.js';
import type { Repositories } from '../repositories/index.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../security/password.js';
import { generateSessionToken, hashSessionToken } from '../security/session-token.js';

export interface AuthenticatedUser {
  id: string;
  objectId: ObjectId;
  email: string;
}

export interface IssuedSession {
  user: Pick<AuthenticatedUser, 'id' | 'email'>;
  token: string;
  expiresAt: Date;
}

const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');

export function createAuthService(
  repos: Repositories,
  config: Pick<Config, 'sessionSecret' | 'sessionTtlMs'>,
) {
  async function issueSession(userId: ObjectId, email: string): Promise<IssuedSession> {
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + config.sessionTtlMs);
    await repos.sessions.create(hashSessionToken(config.sessionSecret, token), userId, expiresAt);
    return { user: { id: userId.toHexString(), email }, token, expiresAt };
  }

  return {
    async register(input: RegisterInput): Promise<IssuedSession> {
      const passwordHash = await hashPassword(input.password);
      try {
        const user = await repos.users.create(input.email, passwordHash);
        return await issueSession(user._id, user.email);
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
        }
        throw err;
      }
    },

    async login(input: LoginInput): Promise<IssuedSession> {
      const user = await repos.users.findByEmail(input.email);
      if (!user) {
        await verifyAgainstDummy(input.password);
        throw invalidCredentials();
      }
      if (!(await verifyPassword(user.passwordHash, input.password))) throw invalidCredentials();
      return issueSession(user._id, user.email);
    },

    async logout(token: string): Promise<void> {
      await repos.sessions.deleteByTokenHash(hashSessionToken(config.sessionSecret, token));
    },

    /**
     * Resolves a cookie token to its user. Throws 401 UNAUTHENTICATED for unknown tokens and
     * 401 SESSION_EXPIRED for a known but expired session (which is also removed).
     */
    async authenticate(token: string): Promise<AuthenticatedUser> {
      const tokenHash = hashSessionToken(config.sessionSecret, token);
      const session = await repos.sessions.findByTokenHash(tokenHash);
      if (!session) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
      if (session.expiresAt.getTime() <= Date.now()) {
        await repos.sessions.deleteByTokenHash(tokenHash);
        throw new AppError(
          401,
          'SESSION_EXPIRED',
          'Your session has expired. Please sign in again.',
        );
      }
      const user = await repos.users.findById(session.userId);
      if (!user) {
        await repos.sessions.deleteByTokenHash(tokenHash);
        throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
      }
      return { id: user._id.toHexString(), objectId: user._id, email: user.email };
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
