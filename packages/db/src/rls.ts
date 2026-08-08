import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';

/**
 * Row-level security (plan §12.6, §16.5). RLS is enabled on every table from
 * day one even though V1 ships single-org. Workers `SET LOCAL kanal.org_id`
 * at the start of every transaction. Background jobs that legitimately span
 * orgs (price-table refresh, model probes) run as a separate role with
 * BYPASSRLS, and that role's usage is audited.
 */

const ALL_TABLES = [
  'org', 'channel', 'source', 'source_item', 'run', 'run_step', 'post', 'post_revision',
  'approval', 'publish_intent', 'publish_attempt', 'claim', 'provider', 'model', 'model_price', 'cost_ledger',
  'agent_manifest', 'prompt_pack', 'voice_pack', 'policy', 'source_binding', 'metric_snapshot',
  'audit_event', 'experiment', 'mtproto_session',
];

export const ENABLE_RLS_SQL = ALL_TABLES.map(
  (t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`,
).join('\n');

/**
 * The org table is the root: RLS on it matches the org's own id. Every other
 * table matches the org_id column.
 */
export const RLS_POLICY_SQL = [
  `
CREATE POLICY org_isolation ON org
  USING (id = current_setting('kanal.org_id', true)::uuid);
CREATE POLICY org_isolation_read ON org
  FOR SELECT
  USING (id = current_setting('kanal.org_id', true)::uuid);`,
  ...ALL_TABLES.filter((t) => t !== 'org').map(
    (t) => `
CREATE POLICY org_isolation ON ${t}
  USING (org_id = current_setting('kanal.org_id', true)::uuid);
CREATE POLICY org_isolation_read ON ${t}
  FOR SELECT
  USING (org_id = current_setting('kanal.org_id', true)::uuid);`,
  ),
].join('\n');

/** Grant the service role BYPASSRLS for org-spanning background jobs. */
export const BYPASS_ROLE_SQL = `
CREATE ROLE kanal_background NOINHERIT;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO kanal_background;
ALTER ROLE kanal_background BYPASSRLS;
`;

/**
 * Sets the org context for the current transaction. Call at the start of every
 * transaction: `await db.execute(sql\`SELECT set_config('kanal.org_id', ${orgId}, true)\`)`.
 */
export function setOrgContext(
  db: ReturnType<typeof drizzle>,
  orgId: string,
): Promise<unknown> {
  return db.execute(
    sql`SELECT set_config('kanal.org_id', ${orgId}, true)`,
  );
}
