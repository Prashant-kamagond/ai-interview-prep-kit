import type { LoginInput, RegisterInput } from '@trao/contracts';
import type { ApiClient, RequestOptions } from './client';

export interface User {
  id: string;
  email: string;
}

export interface AuthApi {
  me(options?: RequestOptions): Promise<User>;
  login(input: LoginInput): Promise<User>;
  register(input: RegisterInput): Promise<User>;
  /** Idempotent on the server: always succeeds, even without a session. */
  logout(): Promise<void>;
}

export function createAuthApi(client: ApiClient): AuthApi {
  return {
    me: async (options) => (await client.get<{ user: User }>('/auth/me', options)).user,
    login: async (input) => (await client.post<{ user: User }>('/auth/login', input)).user,
    register: async (input) => (await client.post<{ user: User }>('/auth/register', input)).user,
    logout: async () => {
      await client.post<void>('/auth/logout');
    },
  };
}
