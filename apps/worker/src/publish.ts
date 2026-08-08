import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { TelegramAdapter, TelegramClient, idempotencyKey } from '@kanal/adapters-telegram';
import type { ChannelRef } from '@kanal/adapters-core';
import { setOrgContext } from './db.js';

/**
 * The publish role (plan §12.7, §10.5). Deliberately boring and singleton-locked
 * (1 per channel). A publish job carries a run id; the worker:
 *
 *   1. loads the run + the channel + the latest revision,
 *   2. verifies an open `publish_intent` exists (plan §4.1 — publish is never
 *      an agent's decision; the intent row is the only authorizer),
 *   3. publishes via the Telegram adapter with an idempotency key derived from
 *      post|revision|channel|part (§10.5),
 *   4. records a `publish_attempt` row and marks the intent consumed.
 *
 * `uncertain` outcomes are NEVER auto-retried (plan §10.6): they are recorded
 * and surfaced for a human, not re-sent.
 */

export interface PublishJobPayload {
  runId: string;
  attempt?: number;
}

interface ChannelForPublish {
  id: string;
  org_id: string;
  platform_channel_id: string;
  handle: string | null;
  content_locale: string;
  numeral_system: string;
  credential_ref: string;
}

interface PublishTarget {
  run_id: string;
  post_id: string;
  revision_id: string;
  body_rendered: string;
  channel: ChannelForPublish;
}

export function createPublishHandler(
  db: NodePgDatabase,
  opts: { dryRun?: boolean } = {},
): (job: PublishJobPayload) => Promise<{ status: string; platformMessageId: string | null }> {
  const dryRun = opts.dryRun ?? false;

  return async function handle(job: PublishJobPayload): Promise<{ status: string; platformMessageId: string | null }> {
    const target = await loadPublishTarget(db, job.runId);
    if (!target) return { status: 'no_target', platformMessageId: null };

    await setOrgContext(db, target.channel.org_id);

    // The intent row is the only authorizer (plan §4.1, §7.2).
    const intent = await openIntent(db, target.run_id);
    if (!intent) {
      console.warn(`[publish] run ${target.run_id} has no open publish_intent — refusing to publish`);
      return { status: 'no_intent', platformMessageId: null };
    }

    const partIndex = 0;
    const idem = idempotencyKey(target.post_id, target.revision_id, target.channel.id, partIndex);

    // An idempotent duplicate: the attempt row already exists → return it.
    const prior = await existingAttempt(db, idem);
    if (prior) {
      return { status: prior.state, platformMessageId: prior.platform_message_id };
    }

    if (dryRun) {
      await recordAttempt(db, target, idem, 'succeeded', `dryrun:${idem.slice(0, 12)}`, null);
      await consumeIntent(db, intent.id);
      return { status: 'succeeded', platformMessageId: `dryrun:${idem.slice(0, 12)}` };
    }

    const botToken = resolveBotToken(target.channel.credential_ref);
    if (!botToken) {
      await recordAttempt(db, target, idem, 'failed', null, 'no bot token configured for channel credential_ref');
      return { status: 'failed', platformMessageId: null };
    }

    const client = new TelegramClient({ botToken, baseUrl: process.env.KANAL_TELEGRAM_API ?? 'https://api.telegram.org/bot' });
    const adapter = new TelegramAdapter(client);
    const channelRef: ChannelRef = {
      platformChannelId: target.channel.platform_channel_id,
      handle: target.channel.handle ?? undefined,
      contentLocale: target.channel.content_locale,
      numeralSystem: target.channel.numeral_system === 'arabext' ? 'arabext' : 'latn',
    };

    const outcome = await adapter.publish({
      channel: channelRef,
      rendered: {
        body: target.body_rendered,
        markupMode: 'html',
        parts: [],
        media: [],
        linkPreview: 'auto',
        silent: false,
        protectContent: false,
      },
      idempotencyKey: idem,
    });

    switch (outcome.kind) {
      case 'ok':
        await recordAttempt(db, target, idem, 'succeeded', outcome.platformMessageId, null);
        await consumeIntent(db, intent.id);
        return { status: 'succeeded', platformMessageId: outcome.platformMessageId };
      case 'uncertain':
        // NEVER auto-retried (plan §10.6) — recorded and surfaced for a human.
        await recordAttempt(db, target, idem, 'uncertain', null, outcome.reason);
        return { status: 'uncertain', platformMessageId: null };
      case 'rate_limited':
        await recordAttempt(db, target, idem, 'failed', null, `rate_limited: retry after ${outcome.retryAfterSeconds}s`);
        return { status: 'failed', platformMessageId: null };
      case 'rejected':
        await recordAttempt(db, target, idem, 'failed', null, `${outcome.code}: ${outcome.description}`);
        return { status: 'failed', platformMessageId: null };
      case 'unauthorized':
        await recordAttempt(db, target, idem, 'failed', null, `unauthorized: ${outcome.description}`);
        return { status: 'failed', platformMessageId: null };
      case 'not_found':
        await recordAttempt(db, target, idem, 'failed', null, `not_found: ${outcome.description}`);
        return { status: 'failed', platformMessageId: null };
      default: {
        // Exhaustive over the PublishOutcome union; unreachable when the
        // contract grows a new variant, kept as a typed guard.
        const never: never = outcome;
        void never;
        await recordAttempt(db, target, idem, 'failed', null, 'unknown publish outcome');
        return { status: 'failed', platformMessageId: null };
      }
    }
  };
}

// ---- helpers -----------------------------------------------------------------

async function loadPublishTarget(db: NodePgDatabase, runId: string): Promise<PublishTarget | null> {
  const rows = await db.execute(sql`
    SELECT r.id AS run_id, r.org_id,
           p.id AS post_id, pr.id AS revision_id, pr.body_rendered,
           c.id, c.platform_channel_id, c.handle, c.content_locale, c.credential_ref,
           (SELECT numeral_system FROM org WHERE id = r.org_id) AS numeral_system
    FROM run r
    JOIN post p ON p.run_id = r.id
    JOIN post_revision pr ON pr.post_id = p.id AND pr.revision_no = (
      SELECT max(revision_no) FROM post_revision WHERE post_id = p.id
    )
    JOIN channel c ON c.id = r.channel_id
    WHERE r.id = ${runId};
  `);
  const r = rows.rows[0] as unknown as PublishTarget | undefined;
  return r ?? null;
}

async function openIntent(db: NodePgDatabase, runId: string): Promise<{ id: string } | null> {
  const rows = await db.execute(sql`
    SELECT id FROM publish_intent WHERE run_id = ${runId} AND consumed = false
    ORDER BY created_at LIMIT 1;
  `);
  return (rows.rows[0] as unknown as { id: string } | undefined) ?? null;
}

async function existingAttempt(db: NodePgDatabase, idem: string): Promise<{ state: string; platform_message_id: string | null } | null> {
  const rows = await db.execute(sql`
    SELECT state, platform_message_id FROM publish_attempt WHERE idempotency_key = ${idem}::bytea LIMIT 1;
  `);
  return (rows.rows[0] as unknown as { state: string; platform_message_id: string | null } | undefined) ?? null;
}

async function recordAttempt(
  db: NodePgDatabase,
  target: PublishTarget,
  idem: string,
  state: 'succeeded' | 'failed' | 'uncertain',
  platformMessageId: string | null,
  errorDesc: string | null,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO publish_attempt (org_id, post_id, revision_id, channel_id, platform, idempotency_key, state,
                                 platform_message_id, responded_at, platform_error_desc, attempt_no)
    VALUES (${target.channel.org_id}, ${target.post_id}, ${target.revision_id}, ${target.channel.id}, 'telegram',
            ${idem}::bytea, ${state}, ${platformMessageId}, now(), ${errorDesc}, 1)
    ON CONFLICT (idempotency_key) DO NOTHING;
  `);
}

async function consumeIntent(db: NodePgDatabase, intentId: string): Promise<void> {
  await db.execute(sql`UPDATE publish_intent SET consumed = true, consumed_at = now() WHERE id = ${intentId}`);
}

/** Resolve the bot token from a credential_ref (a Vault/k8s secret reference). */
export function resolveBotToken(credentialRef: string): string | null {
  if (!credentialRef) return null;
  // If the ref is itself the token (dev/test), use it; otherwise treat it as
  // an env-var name to read. Production installs inject the token via the
  // environment; the plan binds credentials at the channel level (§10.3).
  const direct = process.env[credentialRef];
  if (direct) return direct;
  if (process.env.KANAL_TELEGRAM_BOT_TOKEN) return process.env.KANAL_TELEGRAM_BOT_TOKEN;
  // Ref is a secret path we cannot read from this process (sidecar/vault).
  return null;
}
