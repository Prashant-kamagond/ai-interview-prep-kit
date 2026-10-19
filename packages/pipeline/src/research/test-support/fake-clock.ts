import type { Clock } from '../clock.js';

export interface FakeClock extends Clock {
  /** Every sleep requested, in order. */
  sleeps: number[];
  advance(ms: number): void;
}

/** Time only moves when something sleeps or the test advances it, so waits cost nothing. */
export function createFakeClock(start = 1_000_000): FakeClock {
  let time = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    async sleep(ms) {
      sleeps.push(ms);
      time += ms;
    },
    advance(ms) {
      time += ms;
    },
  };
}
