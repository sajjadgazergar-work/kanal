/**
 * Fetch rate limiting (plan §8.2): per-host concurrency 2, global ingest
 * concurrency 8, 1 rps per host with jitter.
 */

const GLOBAL_MAX = 8;
const PER_HOST_MAX = 2;
const RPS_PER_HOST = 1;

export class RateLimiter {
  private globalActive = 0;
  private hostActive = new Map<string, number>();
  private hostTimestamps = new Map<string, number[]>();
  private globalQueue: Array<() => void> = [];
  private hostQueues = new Map<string, Array<() => void>>();

  private maxGlobal: number;
  private maxPerHost: number;
  private rpsPerHost: number;

  constructor(opts: { maxGlobal?: number; maxPerHost?: number; rpsPerHost?: number } = {}) {
    this.maxGlobal = opts.maxGlobal ?? GLOBAL_MAX;
    this.maxPerHost = opts.maxPerHost ?? PER_HOST_MAX;
    this.rpsPerHost = opts.rpsPerHost ?? RPS_PER_HOST;
  }

  /**
   * Wait for a slot, then run `fn`. The host is derived from the URL.
   */
  async run<T>(url: string, fn: () => Promise<T>): Promise<T> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      host = 'unknown';
    }

    await this.acquire(host);
    try {
      return await fn();
    } finally {
      this.release(host);
    }
  }

  private async acquire(host: string): Promise<void> {
    const waiters: Promise<void>[] = [];
    if (this.globalActive >= this.maxGlobal) {
      waiters.push(
        new Promise<void>((resolve) => this.globalQueue.push(resolve)),
      );
    }
    const hostActive = this.hostActive.get(host) ?? 0;
    if (hostActive >= this.maxPerHost) {
      waiters.push(
        new Promise<void>((resolve) => {
          const q = this.hostQueues.get(host) ?? [];
          q.push(resolve);
          this.hostQueues.set(host, q);
        }),
      );
    }
    // Per-host rate (1 rps with jitter): space releases by
    // (1000/rps ± 40%) randomized, and cap the number of outstanding releases.
    const last = this.hostTimestamps.get(host) ?? [];
    const now = Date.now();
    const recent = last.filter((t) => now - t < 1000);
    if (recent.length >= this.rpsPerHost) {
      const jitterMs = 1000 / this.rpsPerHost + (Math.random() * 800 - 400);
      waiters.push(new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, jitterMs))));
    }

    await Promise.all(waiters);
    this.globalActive++;
    this.hostActive.set(host, (this.hostActive.get(host) ?? 0) + 1);
    const ts = this.hostTimestamps.get(host) ?? [];
    ts.push(Date.now());
    this.hostTimestamps.set(host, ts.filter((t) => Date.now() - t < 1000));
  }

  private release(host: string): void {
    this.globalActive--;
    const nextGlobal = this.globalQueue.shift();
    if (nextGlobal) nextGlobal();
    const hostActive = (this.hostActive.get(host) ?? 1) - 1;
    this.hostActive.set(host, Math.max(0, hostActive));
    const q = this.hostQueues.get(host) ?? [];
    const next = q.shift();
    if (next) next();
  }
}
