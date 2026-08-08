import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Inbound source webhook receiver (plan §19 row 8, §10.2):
 *
 *   POST /api/v1/sources/:id/webhook
 *
 * Signature: HMAC-SHA256 over the *raw* body with a per-source secret,
 * constant-time compare, 5-minute timestamp window, and a replay cache keyed
 * by (sourceId, signature) so a replayed delivery is rejected.
 */

/** Maximum accepted skew between the client clock and ours (plan §19 row 8). */
const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

export interface WebhookSecretStore {
  /**
   * Return the secret for a source, or null when the source does not exist or
   * has no webhook secret configured. The V1 implementation reads the `source`
   * row's `config.webhook_secret`.
   */
  getSecret(sourceId: string): Promise<string | null>;
}

export type WebhookEventHook = (sourceId: string, payload: unknown) => Promise<void>;
export type WebhookClock = () => number;

export interface WebhookRoutesOptions {
  secrets: WebhookSecretStore;
  /** Optional hook called after a verified event; enables unit tests. */
  onVerifiedEvent?: WebhookEventHook;
  /** Override the current time (ms since epoch) for tests. */
  now?: WebhookClock;
}

interface SignedWebhook {
  /** The signature the client attached (hex). */
  signature: string;
  /** Unix ms timestamp included in the signed payload. */
  timestamp: string;
}

/** Parse `Kanal-Signature: t=<ts>,v1=<hex>` — returns null on malformed input. */
export function parseSignatureHeader(header: string | undefined): SignedWebhook | null {
  if (typeof header !== 'string') return null;
  const parts: Record<string, string> = {};
  for (const pair of header.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    parts[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  const t = parts['t'];
  const v = parts['v1'];
  if (t === undefined || v === undefined || !/^\d+$/.test(t)) return null;
  return { signature: v, timestamp: t };
}

/** Build the signed string: `<timestamp>.<body>`. */
export function signedPayload(timestamp: string, body: Buffer): string {
  return `${timestamp}.${body.toString('utf8')}`;
}

/**
 * Reject JSON bodies that smuggle prototype-pollution keys (`__proto__`,
 * `constructor.prototype`) — mirrors Fastify's default `onProtoPoisoning`
 * behaviour, which we bypass by overriding the content-type parser.
 */
function hasPoisonKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (hasPoisonKey(item)) return true;
    }
    return false;
  }
  if (typeof value !== 'object' || value === null) return false;
  const keys = Object.keys(value);
  if (keys.includes('__proto__') || keys.includes('constructor')) return true;
  for (const key of keys) {
    if (hasPoisonKey((value as Record<string, unknown>)[key])) return true;
  }
  return false;
}

/** Constant-time compare of two hex strings. */
export function safeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a.toLowerCase(), 'hex');
  const bufB = Buffer.from(b.toLowerCase(), 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Compute the HMAC-SHA256 hex digest. */
export function computeSignature(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

export class ReplayCache {
  private readonly seen = new Set<string>();
  private readonly maxEntries: number;

  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
  }

  /** Returns true when this (sourceId, signature) was already seen. */
  isReplay(sourceId: string, signature: string): boolean {
    return this.seen.has(`${sourceId}:${signature}`);
  }

  markSeen(sourceId: string, signature: string): void {
    this.seen.add(`${sourceId}:${signature}`);
    if (this.seen.size > this.maxEntries) {
      // Evict the oldest insertions to bound memory.
      const iter = this.seen.values();
      const toDelete = this.seen.size - this.maxEntries;
      for (let i = 0; i < toDelete; i++) {
        const first = iter.next().value;
        if (first !== undefined) this.seen.delete(first);
      }
    }
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export async function registerWebhookRoutes(app: FastifyInstance, opts: WebhookRoutesOptions): Promise<void> {
  const { secrets, onVerifiedEvent, now = () => Date.now() } = opts;
  const replayCache = new ReplayCache();

  // Capture the raw body for HMAC verification. The signature is computed over
  // the exact bytes, so we must not let a JSON parser mutate or re-stringify it.
  app.addContentTypeParser(
    ['application/json', 'text/plain', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: 1_048_576 },
    (request, body, done) => {
      const buf = body as Buffer;
      // Keep the exact bytes for HMAC; decode a JSON body for the handler.
      (request as FastifyRequest & { rawBody?: Buffer }).rawBody = buf;
      if (buf.length === 0) {
        done(null, undefined);
        return;
      }
      const type = request.headers['content-type'] ?? '';
      if (type.includes('application/json')) {
        try {
          const parsed: unknown = JSON.parse(buf.toString('utf8'));
          // Match Fastify's default prototype-poisoning guard: reject bodies
          // that smuggle __proto__ / constructor keys (plan §16.2 #18).
          if (hasPoisonKey(parsed)) {
            done(new Error('invalid JSON body'));
            return;
          }
          done(null, parsed);
        } catch {
          done(new Error('invalid JSON body'));
        }
        return;
      }
      done(null, buf.toString('utf8'));
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/sources/:id/webhook',
    async (request, reply) => {
      const sourceId = (request.params as { id: string }).id;
      if (typeof sourceId !== 'string' || sourceId.length === 0) {
        return reply.code(400).send({ error: 'invalid_id', message: 'source id is required' });
      }

      // 1. Signature header shape.
      const sigHeader = request.headers['kanal-signature'];
      const parsed = parseSignatureHeader(typeof sigHeader === 'string' ? sigHeader : undefined);
      if (parsed === null) {
        return reply.code(400).send({ error: 'invalid_signature', message: 'missing or malformed Kanal-Signature header' });
      }

      // 2. Replay cache (plan §19 row 8).
      if (replayCache.isReplay(sourceId, parsed.signature)) {
        return reply.code(202).send({ ok: true, replayed: true });
      }

      // 3. Timestamp window.
      const tsMs = Number(parsed.timestamp);
      if (!Number.isFinite(tsMs)) {
        return reply.code(400).send({ error: 'invalid_timestamp', message: 'timestamp is not a number' });
      }
      if (Math.abs(now() - tsMs) > MAX_TIMESTAMP_SKEW_MS) {
        return reply.code(401).send({ error: 'stale_signature', message: 'signature timestamp outside the accepted window' });
      }

      // 4. Look up the per-source secret.
      const secret = await secrets.getSecret(sourceId);
      if (secret === null) {
        return reply.code(404).send({ error: 'source_not_found', message: 'no webhook secret for this source' });
      }

      // 5. Verify HMAC-SHA256 over the raw body.
      const rawBody = request.rawBody ?? Buffer.alloc(0);
      const expected = computeSignature(secret, signedPayload(parsed.timestamp, rawBody));
      if (!safeHexEqual(parsed.signature, expected)) {
        return reply.code(401).send({ error: 'invalid_signature', message: 'signature verification failed' });
      }

      // 6. Deliver. Mark seen only after a successful dispatch so a dropped
      //    connection can retry without being eaten by the cache.
      replayCache.markSeen(sourceId, parsed.signature);
      await onVerifiedEvent?.(sourceId, request.body);
      return reply.code(202).send({ ok: true });
    },
  );
}
