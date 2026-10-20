import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * vercel.json is the only thing that decides what is public on a Vercel deployment, so its shape is pinned
 * here: which services exist, which paths reach which one, that nothing is wired that should not be, and
 * that no secret is written into it. The syntax follows Vercel's Services documentation (checked
 * 2026-10-20); whether Vercel accepts it can only be confirmed by a deployment.
 */

const root = process.cwd();
const raw = readFileSync(join(root, 'vercel.json'), 'utf8');
const config = JSON.parse(raw) as {
  services: Record<string, Record<string, unknown>>;
  rewrites: { source: string; destination: { service: string } }[];
  [key: string]: unknown;
};

describe('vercel.json', () => {
  it('declares exactly the web and api services, each with a root that exists', () => {
    expect(Object.keys(config.services).sort()).toEqual(['api', 'web']);
    expect(config.services.web!.root).toBe('apps/web/');
    expect(config.services.api!.root).toBe('apps/api/');
    for (const service of Object.values(config.services)) {
      expect(existsSync(join(root, String(service.root), 'package.json'))).toBe(true);
    }
  });

  it('points the api service at a file that exists and exports the app instead of listening', () => {
    const entry = String(config.services.api!.entrypoint);
    expect(entry).toBe('src/server.ts');
    const source = readFileSync(join(root, 'apps/api', entry), 'utf8');
    expect(source).toMatch(/export default /);
    expect(source).toMatch(/from 'express'/);
    expect(source).not.toMatch(/\.listen\(/);
  });

  it('makes /api/* the only public path to the API and sends everything else to the web app', () => {
    expect(config.rewrites).toEqual([
      { source: '/api/(.*)', destination: { service: 'api' } },
      { source: '/(.*)', destination: { service: 'web' } },
    ]);
  });

  it('strips the /api prefix before the Express app sees the path (its routes have none)', () => {
    const routes = config.services.api!.routes as {
      src: string;
      transforms: { type: string; op: string; args: string }[];
    }[];
    expect(routes).toHaveLength(1);
    expect(routes[0]!.src).toBe('/api/(.*)');
    expect(routes[0]!.transforms).toEqual([{ type: 'request.path', op: 'set', args: '/$1' }]);
    const apply = (path: string) =>
      path.replace(new RegExp(`^${routes[0]!.src}$`), routes[0]!.transforms[0]!.args);
    expect(apply('/api/kits')).toBe('/kits');
    expect(apply('/api/auth/login')).toBe('/auth/login');
    expect(apply('/api/kits/abc/practice/cards/c1')).toBe('/kits/abc/practice/cards/c1');
    expect(apply('/api/health')).toBe('/health');
  });

  it('declares no bindings: the browser calls the API through the public route, the web app never does', () => {
    for (const service of Object.values(config.services))
      expect(service).not.toHaveProperty('bindings');
  });

  it('keeps build and runtime settings out of the top level, where they would be ambiguous', () => {
    for (const key of [
      'functions',
      'installCommand',
      'buildCommand',
      'devCommand',
      'ignoreCommand',
      'outputDirectory',
      'framework',
    ]) {
      expect(config).not.toHaveProperty(key);
    }
  });

  it('builds the web app with the command that refuses a missing or localhost API address', () => {
    expect(config.services.web!.buildCommand).toBe('pnpm build:production');
    const pkg = JSON.parse(readFileSync(join(root, 'apps/web/package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['build:production']).toMatch(/check-production-env/);
  });

  it('contains no secret, no database address and no environment values', () => {
    expect(raw).not.toMatch(/mongodb(\+srv)?:\/\//i);
    expect(raw).not.toMatch(/gsk_|AIza|sk-|SESSION_SECRET|API_KEY|password/i);
    expect(config).not.toHaveProperty('env');
    expect(config).not.toHaveProperty('build');
  });
});
