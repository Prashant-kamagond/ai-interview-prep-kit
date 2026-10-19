import { defineConfig } from 'vitest/config';

// Unit tests only: nothing here needs a database. Integration tests run via
// vitest.integration.config.ts (`pnpm test:integration`) against a real MongoDB.
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/api/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
    environment: 'node',
  },
});
