import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { buildServer } from './server.js';
import { PgRunner } from '@kanal/core';
import type { WebhookSecretStore } from './routes/webhook.js';

/**
 * API bootstrap. Refuses to boot without `KANAL_API_KEY` (plan §20.1 — no
 * default credentials, no anonymous mode). Binds 127.0.0.1 by default
 * (plan §16.3), overridable with `KANAL_HOST` / `KANAL_PORT`.
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`missing required environment variable ${name} — refusing to boot`);
  }
  return value.trim();
}

const API_KEY = requiredEnv('KANAL_API_KEY');
// Refuse placeholder/default-looking keys too.
if (/^(changeme|replace|default|your[-_]?key|example)/i.test(API_KEY)) {
  throw new Error('KANAL_API_KEY looks like a placeholder — set a real key and restart');
}

const HOST = process.env.KANAL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.KANAL_PORT ?? 3001);

const DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.KANAL_DATABASE_URL ??
  'postgres://kanal:kanal@localhost:5432/kanal';

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
const db = drizzle(pool);
const runner = new PgRunner(db);

const webhookSecrets: WebhookSecretStore = {
  async getSecret(sourceId: string): Promise<string | null> {
    const rows = await db.execute(
      sql`SELECT config FROM source WHERE id = ${sourceId}`,
    );
    const row = rows.rows[0] as { config?: Record<string, unknown> } | undefined;
    if (row === undefined) return null;
    const secret = row.config?.['webhook_secret'];
    return typeof secret === 'string' && secret.length > 0 ? secret : null;
  },
};

const pingDb = async (): Promise<boolean> => {
  const res = await pool.query('SELECT 1');
  return (res.rows[0] as { '?column?': number })['?column?'] === 1;
};

const app = buildServer({
  apiKey: API_KEY,
  runner,
  webhookSecrets,
  pingDb,
});

try {
  await app.listen({ host: HOST, port: PORT });
  app.log.info({ host: HOST, port: PORT }, 'kanal api listening');
} catch (err) {
  app.log.fatal(err, 'failed to start kanal api');
  process.exit(1);
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
  } finally {
    await pool.end();
  }
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
