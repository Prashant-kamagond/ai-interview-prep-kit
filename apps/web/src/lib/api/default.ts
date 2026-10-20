import { createAuthApi } from './auth';
import { createApiClient, type ApiError } from './client';
import { createBuilderApi } from './builder';
import { createJobsApi } from './jobs';
import { createKitsApi } from './kits';
import { createPracticeApi } from './practice';
import { createRegenerationApi } from './regeneration';

/**
 * The app-wide API client. When any request learns that the session is gone, interested parts of
 * the UI (the auth provider) hear about it through this small bus instead of every caller having
 * to check.
 */
type Listener = (error: ApiError) => void;
const listeners = new Set<Listener>();

export function onSessionLost(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const apiClient = createApiClient({
  onUnauthorized: (error) => {
    for (const listener of [...listeners]) listener(error);
  },
});

export const authApi = createAuthApi(apiClient);
export const kitsApi = createKitsApi(apiClient);
export const jobsApi = createJobsApi(apiClient);
export const builderApi = createBuilderApi(apiClient);
export const regenerationApi = createRegenerationApi(apiClient);
export const practiceApi = createPracticeApi(apiClient);
