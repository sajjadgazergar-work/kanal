import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { setOrgContext } from './db.js';

/**
 * The metrics role (plan §12.7, §9.2 #15, §17.2). Cron-driven snapshots at
 * +15m/+1h/+6h/+24h/+72h after a publish. Bot API has no views/forwards, so
 * this worker records what it can (member counts) and leaves a marker that the
 * MTProto sidecar would fill (plan §17.2 degraded-operation matrix).
 *
 * A metrics job carries a `publish_attempt_id`; the worker snapshots the
 * channel member count (from the stored attempt's channel) and stores rows in
 * `metric_snapshot`. When the sidecar is off, `source='bot_api'` rows carry
 * `value=0` with the caveat documented in the degraded matrix.
 */

export interface MetricsJobPayload {
  publishAttemptId: string;
}

interface AttemptRow {
  id: string;
  org_id: string;
  channel_id: string;
  platform_message_id: string | null;
}

export function createMetricsHandler(
  db: NodePgDatabase,
  opts: { memberCount?: (channelId: string) => Promise<number> } = {},
): (job: MetricsJobPayload) => Promise<{ captured: string[] }> {
  const memberCount = opts.memberCount ?? (async () => 0);

  return async function handle(job: MetricsJobPayload): Promise<{ captured: string[] }> {
    const attempt = await loadAttempt(db, job.publishAttemptId);
    if (!attempt) return { captured: [] };

    await setOrgContext(db, attempt.org_id);

    const members = await memberCount(attempt.channel_id);
    const captured: string[] = [];

    // Store the member count (available via Bot API §10.3).
    await insertSnapshot(db, attempt, 'bot_api', 'members', members);
    captured.push('members');

    // Views/forwards/reactions are sidecar-only in V1 (plan §17.2): record a
    // 0 marker so the series has rows at every cadence; the sidecar overwrites.
    for (const metric of ['views', 'forwards', 'reactions'] as const) {
      await insertSnapshot(db, attempt, 'bot_api', metric, 0);
      captured.push(metric);
    }

    return { captured };
  };
}

async function loadAttempt(db: NodePgDatabase, id: string): Promise<AttemptRow | null> {
  const rows = await db.execute(sql`
    SELECT id, org_id, channel_id, platform_message_id FROM publish_attempt WHERE id = ${id};
  `);
  return (rows.rows[0] as unknown as AttemptRow | undefined) ?? null;
}

async function insertSnapshot(
  db: NodePgDatabase,
  attempt: AttemptRow,
  source: 'bot_api' | 'mtproto',
  metric: string,
  value: number,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO metric_snapshot (org_id, publish_attempt_id, captured_at, source, metric, value)
    VALUES (${attempt.org_id}, ${attempt.id}, now(), ${source}, ${metric}, ${value});
  `);
}
