/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages export TypeScript source directly, so Next must compile them.
  transpilePackages: ['@trao/contracts', '@trao/core'],
};

/**
 * NEXT_PUBLIC_API_URL is baked into the bundle at build time. A plain `next build` stays permissive (so the
 * local build and CI work), but says so loudly. A deployment should build with `pnpm build:production`, which
 * refuses to build without a public https address (scripts/check-production-env.ts).
 */
export default function config(phase) {
  if (phase === 'phase-production-build') {
    const url = (process.env.NEXT_PUBLIC_API_URL ?? '').trim();
    if (url === '' || /^https?:\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(url)) {
      console.warn(
        '\n[warning] NEXT_PUBLIC_API_URL is unset or points at localhost. This build only works on a developer machine:\n' +
          '          the deployed app would refuse to run. For a deployment use `pnpm build:production` (see docs/deployment.md).\n',
      );
    }
  }
  return nextConfig;
}
