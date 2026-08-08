import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * Database connection for the worker. Uses a dedicated pool sized for the
 * four roles (§12.7): pipeline + ingest are the concurrent ones, publish is
 * singleton-locked, metrics is light.
 */
export function createDb(connectionString: string, poolSize = 8): { db: NodePgDatabase; pool: Pool } {
  const pool = new Pool({ connectionString, max: poolSize });
  const db = drizzle(pool);
  return { db, pool };
}

export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.KANAL_DATABASE_URL ??
    env.DATABASE_URL ??
    'postgres://kanal:kanal@localhost:5432/kanal'
  );
}

/** Set `kanal.org_id` for the current transaction (plan §12.6, §16.5). */
export async function setOrgContext(db: NodePgDatabase, orgId: string): Promise<void> {
  await db.execute(sql`SELECT set_config('kanal.org_id', ${orgId}, true)`);
}
