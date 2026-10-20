import { vi } from 'vitest';

/**
 * A stand-in for `next/navigation` in component tests. Import it from a `vi.mock` factory:
 *
 *   vi.mock('next/navigation', async () => (await import('../../test/navigation')).navigationMock);
 */
export const router = {
  replace: vi.fn(),
  push: vi.fn(),
  back: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
};

export const nav = { pathname: '/kits' };

export const navigationMock = {
  useRouter: () => router,
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
};

export function resetNavigation(pathname = '/kits', search = ''): void {
  router.replace.mockReset();
  router.push.mockReset();
  nav.pathname = pathname;
  window.history.replaceState({}, '', `${pathname}${search}`);
}
