import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * The job queue (plan §12.3). One table partitioned by `queue` column:
 * pipeline, ingest, publish, metrics. Dequeue is `FOR UPDATE SKIP LOCKED`.
 * Workers wake on LISTEN kanal_job_<queue> (a trigger NOTIFYs on insert) and
 * additionally poll every 2s as a safety net.
 */
export type QueueName = 'pipeline' | 'ingest' | 'publish' | 'metrics';

export interface JobRow {
  id: number;
  orgId: string;
  queue: QueueName;
  singletonKey: string | null;
  payload: Record<string, unknown>;
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  state: 'ready' | 'running' | 'done' | 'failed' | 'dead';
  lockedBy: string | null;
  lockedAt: Date | null;
}

export interface EnqueueJob {
  orgId: string;
  queue: QueueName;
  singletonKey?: string;
  payload: Record<string, unknown>;
  runAt?: Date;
  maxAttempts?: number;
}

/**
 * Enqueue a job. When `singletonKey` is set, the unique index on
 * (singleton_key) WHERE state IN ('ready','running') prevents duplicates.
 */
export async function enqueueJob(db: NodePgDatabase, job: EnqueueJob): Promise<JobRow> {
  const rows = await db.execute(sql`
    INSERT INTO job (org_id, queue, singleton_key, payload, run_at, max_attempts, state)
    VALUES (${job.orgId}, ${job.queue}, ${job.singletonKey ?? null}, ${JSON.stringify(job.payload)}::jsonb,
            ${job.runAt ?? new Date()}, ${job.maxAttempts ?? 5}, 'ready')
    ON CONFLICT DO NOTHING
    RETURNING *;
  `);
  return rows.rows[0] as unknown as JobRow;
}

export interface DequeueOptions {
  workerId: string;
  limit?: number;
}

/**
 * Dequeue up to `limit` ready jobs with SKIP LOCKED. Each dequeue is one
 * atomic UPDATE that claims the row.
 */
export async function dequeueJobs(
  db: NodePgDatabase,
  queue: QueueName,
  opts: DequeueOptions,
): Promise<JobRow[]> {
  const rows = await db.execute(sql`
    UPDATE job SET state='running', locked_by=${opts.workerId}, locked_at=now(), attempts=attempts+1
    WHERE id IN (
      SELECT id FROM job
      WHERE queue=${queue} AND state='ready' AND run_at <= now()
      ORDER BY run_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT ${opts.limit ?? 1})
    RETURNING *;
  `);
  return rows.rows as unknown as JobRow[];
}

/** Mark a job done (delete or move to done). */
export async function completeJob(db: NodePgDatabase, id: number): Promise<void> {
  await db.execute(sql`UPDATE job SET state='done', locked_by=NULL WHERE id=${id}`);
}

/** Mark a job failed; dead-letter after max_attempts (plan §12.3). */
export async function failJob(db: NodePgDatabase, id: number, _error: string): Promise<'retryable' | 'dead'> {
  const rows = await db.execute(sql`
    UPDATE job SET state='running', locked_by=NULL
    WHERE id=${id}
    RETURNING attempts, max_attempts;
  `);
  const row = rows.rows[0] as unknown as { attempts: number; max_attempts: number } | undefined;
  if (!row) return 'dead';
  if (row.attempts >= row.max_attempts) {
    await db.execute(sql`UPDATE job SET state='dead', locked_by=NULL WHERE id=${id}`);
    return 'dead';
  }
  await db.execute(sql`UPDATE job SET state='ready', locked_by=NULL, run_at=now() + interval '1 second' WHERE id=${id}`);
  return 'retryable';
}

/** The LISTEN trigger on insert, so workers wake immediately. */
export const NOTIFY_TRIGGER_SQL = `
CREATE OR REPLACE FUNCTION kanal_job_notify()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('kanal_job_' || NEW.queue, NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_notify ON job;
CREATE TRIGGER job_notify AFTER INSERT ON job
FOR EACH ROW EXECUTE FUNCTION kanal_job_notify();
`;
