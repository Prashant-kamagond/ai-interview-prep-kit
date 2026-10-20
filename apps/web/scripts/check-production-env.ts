import { problemsWithDeployedApiUrl } from '../src/lib/api/base-url';

/**
 * Run before a production build (`pnpm build:production`). `NEXT_PUBLIC_API_URL` is baked into the bundle at
 * build time, so a build made without it, or with a localhost or non-https address, would ship an app that
 * cannot reach its API. This refuses to build instead. It never prints the value, only what is wrong.
 */
export function checkProductionEnv(env: Record<string, string | undefined>): string[] {
  return problemsWithDeployedApiUrl(env.NEXT_PUBLIC_API_URL);
}

function main(): void {
  const problems = checkProductionEnv(process.env);
  if (problems.length === 0) {
    process.stdout.write(
      'production environment check: ok (NEXT_PUBLIC_API_URL is set to an https, non-local address)\n',
    );
    return;
  }
  console.error('production environment check FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    'Set NEXT_PUBLIC_API_URL to the public https address of the API, then build again (see docs/deployment.md).',
  );
  process.exit(1);
}

// Only run when executed directly (the tests import checkProductionEnv).
if (process.argv[1] && /check-production-env\.[cm]?[jt]s$/.test(process.argv[1])) main();
