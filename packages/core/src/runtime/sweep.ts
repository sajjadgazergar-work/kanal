import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { enqueueJob } from './queue.js';

/**
 * The approval sweep (plan §12.4). A 60s cron job with two responsibilities:
 *
 * 1. Find `approval` rows that are `granted` but whose run is still parked
 *    (the crash-between-commit-and-enqueue case) and enqueue the next job.
 * 2. Expire rows past `sla_deadline` (escalate to the next approver) and past
 *    `hard_expiry` (cancel the run — timeout is never consent, plan §4.1 #4).
 *
 * The sweep makes push (the API approval handler) an optimization rather than
 * a correctness requirement. Tested by a chaos test that kills the API process
 * between the two statements.
 */
export async function runApprovalSweep(db: NodePgDatabase): Promise<{ resumed: number; escalated: number; expired: number }> {
  // 1. Granted approvals whose run is still parked → resume.
  const granted = await db.execute(sql`
    SELECT a.run_id, a.gate
    FROM approval a
    JOIN run r ON r.id = a.run_id
    WHERE a.state = 'granted' AND r.state = 'review_pending';
  `);
  const resumed = granted.rows.length;
  for (const row of granted.rows as unknown as Array<{ run_id: string; gate: string }>) {
    const state = row.gate === 'topic' ? 'drafting' : 'approved';
    await db.execute(sql`UPDATE run SET state=${state} WHERE id=${row.run_id}`);
    await enqueueJob(db, {
      orgId: (await db.execute(sql`SELECT org_id FROM run WHERE id=${row.run_id}`)).rows[0] as unknown as string,
      queue: 'pipeline',
      singletonKey: `pipeline:${row.run_id}`,
      payload: { runId: row.run_id, state },
    });
  }

  // 2. SLA timeout → escalate to the next approver in the chain.
  const escalated = await db.execute(sql`
    UPDATE approval SET escalated_to_index = escalated_to_index + 1
    WHERE state = 'pending' AND sla_deadline < now() AND escalated_to_index < array_length(escalation_chain, 1) - 1
    RETURNING id;
  `);

  // 3. Hard expiry → cancel the run. Never publish.
  const expired = await db.execute(sql`
    SELECT run_id FROM approval WHERE state = 'pending' AND hard_expiry < now();
  `);
  for (const row of expired as unknown as Array<{ run_id: string }>) {
    await db.execute(sql`
      UPDATE approval SET state='expired' WHERE run_id=${row.run_id} AND state='pending';
      UPDATE run SET state='cancelled', finished_at=now() WHERE id=${row.run_id};
    `);
  }

  return {
    resumed,
    escalated: (escalated.rows as unknown as Array<{ id: string }>).length,
    expired: (expired.rows as unknown as Array<{ run_id: string }>).length,
  };
}

/**
 * The heartbeat reclaimer (plan §5.4, §12.1). On worker boot and on a 30s
 * tick, sweeps `run_step` rows in `in_flight` with `heartbeat_at < now() - 90s`
 * and re-enqueues them. Because each step is memoized by its idempotency key,
 * a re-run of a completed model call returns the stored output instead of
 * re-spending.
 */
export async function reclaimStaleSteps(db: NodePgDatabase): Promise<number> {
  const stale = await db.execute(sql`
    SELECT id, run_id, stage, attempt FROM run_step
    WHERE state = 'in_flight' AND (heartbeat_at IS NULL OR heartbeat_at < now() - interval '90 seconds');
  `);
  const rows = stale.rows as unknown as Array<{ id: string; run_id: string; stage: string; attempt: number }>;
  for (const row of rows) {
    // Reset the step so it can be re-run; the memoized output (if any) is reused.
    await db.execute(sql`UPDATE run_step SET state='queued' WHERE id=${row.id}`);
    await enqueueJob(db, {
      orgId: (await db.execute(sql`SELECT org_id FROM run_step WHERE id=${row.id}`)).rows[0] as unknown as string,
      queue: 'pipeline',
      singletonKey: `pipeline:${row.run_id}`,
      payload: { runId: row.run_id, stage: row.stage, attempt: row.attempt },
    });
  }
  return rows.length;
}
