import { defineConfig } from 'vitest/config';

// Requires MongoDB. Each test file creates and drops its own throwaway database, so files can run
// in parallel. Unreachable MongoDB makes these tests FAIL (never skip), so a green run always
// means the real database was exercised.
export default defineConfig({
  test: {
    include: ['apps/api/**/*.integration.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
