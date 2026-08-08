import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { dequeueJobs, completeJob, failJob, type QueueName, type JobRow } from '@kanal/core';

/**
 * A simple poller for one queue. The job queue supports LISTEN/NOTIFY (the
 * insert trigger NOTIFYs kanal_job_<queue>) but we poll every 2s as the
 * safety net (plan §12.3). This keeps the worker dependency-light and the
 * behaviour obvious.
 */
export interface QueuePoller {
  start(): void;
  stop(): Promise<void>;
}

export function createQueuePoller(
  db: NodePgDatabase,
  queue: QueueName,
  worker: string,
  concurrency: number,
  intervalMs: number,
  handle: (job: JobRow) => Promise<unknown>,
): QueuePoller {
  let stopped = false;
  let inFlight = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const resolving: Promise<void> | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;
    // Respect concurrency: claim at most (concurrency - inFlight) jobs.
    const room = Math.max(0, concurrency - inFlight);
    if (room === 0) return;
    let jobs: JobRow[] = [];
    try {
      jobs = await dequeueJobs(db, queue, { workerId: worker, limit: room });
    } catch (err) {
      console.error(`[${queue}] dequeue failed`, err);
    }
    for (const job of jobs) {
      inFlight++;
      void runJob(job).finally(() => {
        inFlight--;
      });
    }
  }

  async function runJob(job: JobRow): Promise<void> {
    try {
      await handle(job);
      await completeJob(db, job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${queue}] job ${job.id} failed`, message);
      const outcome = await failJob(db, job.id, message);
      if (outcome === 'dead') {
        console.error(`[${queue}] job ${job.id} dead-lettered after max_attempts`);
      }
    }
  }

  return {
    start() {
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      // wait for in-flight jobs to drain (bounded by the timeout of the callers)
      while (inFlight > 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
      void resolving;
    },
  };
}
