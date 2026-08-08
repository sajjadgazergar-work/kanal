/**
 * Per-provider concurrency semaphore (§11.6): a shared key across 20 channels
 * will 429 itself unless concurrency is bounded by `maxConcurrent`.
 */
export class Semaphore {
  readonly limit: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`semaphore limit must be a positive integer, got ${limit}`);
    }
    this.limit = limit;
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  release(): void {
    this.active--;
    if (this.active < 0) this.active = 0;
    const next = this.waiters.shift();
    if (next) next();
  }

  get activeCount(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }
}
