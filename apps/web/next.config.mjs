/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages export TypeScript source directly, so Next must compile them.
  transpilePackages: ['@trao/contracts'],
};

export default nextConfig;
