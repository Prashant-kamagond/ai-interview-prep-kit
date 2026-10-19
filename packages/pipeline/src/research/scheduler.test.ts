import { describe, expect, it } from 'vitest';
import { HostScheduler } from './clock.js';
import { createFakeClock } from './test-support/fake-clock.js';

describe('HostScheduler', () => {
  it('spaces consecutive requests to the same host by the minimum interval', async () => {
    const clock = createFakeClock(0);
    const scheduler = new HostScheduler(clock, 500);
    const starts: number[] = [];
    for (let i = 0; i < 3; i++)
      await scheduler.run('a.test:80', async () => void starts.push(clock.now()));
    expect(starts).toEqual([0, 500, 1000]);
  });

  it('does not delay a request that arrives after the interval has already passed', async () => {
    const clock = createFakeClock(0);
    const scheduler = new HostScheduler(clock, 500);
    await scheduler.run('a.test:80', async () => undefined);
    clock.advance(700);
    const before = clock.sleeps.length;
    await scheduler.run('a.test:80', async () => undefined);
    expect(clock.sleeps.length).toBe(before);
  });

  it('does not make different hosts wait for each other', async () => {
    const clock = createFakeClock(0);
    const scheduler = new HostScheduler(clock, 500);
    const starts: Record<string, number> = {};
    await scheduler.run('a.test:80', async () => void (starts.a = clock.now()));
    await scheduler.run('b.test:80', async () => void (starts.b = clock.now()));
    expect(starts).toEqual({ a: 0, b: 0 });
  });

  it('runs at most one request per host at a time, in submission order', async () => {
    const scheduler = new HostScheduler(createFakeClock(0), 0);
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        scheduler.run('a.test:80', async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 5));
          order.push(n);
          active--;
        }),
      ),
    );
    expect(maxActive).toBe(1);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('keeps working after a task fails', async () => {
    const scheduler = new HostScheduler(createFakeClock(0), 0);
    await expect(
      scheduler.run('a.test:80', async () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(await scheduler.run('a.test:80', async () => 'still fine')).toBe('still fine');
  });

  it('lets a host-specific interval (e.g. robots Crawl-delay) override the default', async () => {
    const clock = createFakeClock(0);
    const scheduler = new HostScheduler(clock, 500);
    scheduler.setMinInterval('slow.test:80', 2000);
    const starts: number[] = [];
    for (let i = 0; i < 2; i++)
      await scheduler.run('slow.test:80', async () => void starts.push(clock.now()));
    expect(starts).toEqual([0, 2000]);
  });
});
