import { describe, expect, it } from 'vitest';
import { Semaphore } from '../semaphore.js';

describe('per-provider concurrency semaphore (§11.6)', () => {
  it('limits concurrent acquisitions to maxConcurrent', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.activeCount).toBe(2);
    expect(sem.queued).toBe(0);

    // Third acquire queues.
    const third = sem.acquire();
    expect(sem.queued).toBe(1);
    sem.release();
    await third;
    expect(sem.activeCount).toBe(2);
    expect(sem.queued).toBe(0);
  });

  it('keeps at most maxConcurrent in-flight calls across many concurrent callers', async () => {
    const sem = new Semaphore(3);
    let inflight = 0;
    let peak = 0;
    const run = async () => {
      await sem.acquire();
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      sem.release();
    };
    await Promise.all(Array.from({ length: 20 }, () => run()));
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('rejects a non-positive limit', () => {
    expect(() => new Semaphore(0)).toThrow();
  });
});
