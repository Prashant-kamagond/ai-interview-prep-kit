import { defineConfig } from 'vitest/config';

// Unit tests only: nothing here needs a database. Integration tests run via
// vitest.integration.config.ts (`pnpm test:integration`) against a real MongoDB.
// Web component tests opt into a DOM with `// @vitest-environment jsdom` at the top of the file;
// everything else runs in plain Node.
export default defineConfig({
  // Next.js itself keeps `jsx: preserve`; tests need the JSX compiled, with the automatic runtime.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: [
      'packages/**/*.test.ts',
      'apps/api/**/*.test.ts',
      'apps/web/**/*.test.{ts,tsx}',
      'scripts/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
    environment: 'node',
  },
});
