export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/**
 * Per-host politeness: at most one request in flight per host, and consecutive requests start at
 * least `minIntervalMs` apart. Different hosts do not wait for each other. A host can have its own
 * interval (for example from robots.txt Crawl-delay).
 */
export class HostScheduler {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly lastStart = new Map<string, number>();
  private readonly intervals = new Map<string, number>();

  constructor(
    private readonly clock: Clock,
    private readonly defaultIntervalMs: number,
  ) {}

  setMinInterval(hostKey: string, ms: number): void {
    this.intervals.set(hostKey, Math.max(0, ms));
  }

  getMinInterval(hostKey: string): number | undefined {
    return this.intervals.get(hostKey);
  }

  run<T>(hostKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(hostKey) ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(async () => {
        const interval = this.intervals.get(hostKey) ?? this.defaultIntervalMs;
        const last = this.lastStart.get(hostKey);
        if (last !== undefined) {
          const wait = last + interval - this.clock.now();
          if (wait > 0) await this.clock.sleep(wait);
        }
        this.lastStart.set(hostKey, this.clock.now());
        return task();
      });
    // A failed task must not poison the queue for the next one.
    this.tails.set(
      hostKey,
      result.catch(() => undefined),
    );
    return result;
  }
}
