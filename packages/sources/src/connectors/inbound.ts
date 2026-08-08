/**
 * Webhook (inbound item, §8.1 + §16.2 #8) and manual connectors.
 *
 * Webhook security (attack #8): HMAC-SHA256 over the raw body with a per-source
 * secret, constant-time compare, 5-minute timestamp window, replay cache.
 * The timestamp is carried in the `KANAL-Signature` header as
 * `t=<unix>[,v1=<hex>]` per Telegram-style signatures.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeText, normalizeTitle } from '../text.js';
import type { SourceItemInput } from '../types.js';

export interface WebhookPayload {
  /** ISO timestamp of the event (freshness window check). */
  timestamp?: string;
  url?: string;
  title?: string;
  content?: string;
  body_text?: string;
  lang?: string;
  [key: string]: unknown;
}

export interface WebhookVerification {
  ok: boolean;
  reason?: string;
}

const replayCache = new Map<string, number>();

/** Test seam — clear the replay cache (module-global state). */
export function resetReplayCache(): void {
  replayCache.clear();
}

/**
 * Verify an HMAC-signed webhook (constant-time compare + timestamp window +
 * replay cache).
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | null | undefined,
  secret: string,
  now: number = Date.now(),
  windowSeconds = 300,
): WebhookVerification {
  if (!signatureHeader) return { ok: false, reason: 'missing signature' };
  const parts = signatureHeader.split(',').map((p) => p.trim());
  const tPart = parts.find((p) => p.startsWith('t='));
  const vPart = parts.find((p) => p.startsWith('v1='));
  if (!tPart || !vPart) return { ok: false, reason: 'malformed signature header' };
  const t = Number(tPart.slice(2));
  if (!Number.isFinite(t)) return { ok: false, reason: 'malformed timestamp' };
  if (Math.abs(now / 1000 - t) > windowSeconds) return { ok: false, reason: 'timestamp outside window' };

  const bodyStr = rawBody instanceof Buffer ? rawBody.toString('utf8') : String(rawBody);
  const payload = t + '.' + bodyStr;
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const provided = vPart.slice(3);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad signature' };

  const replayKey = `${t}.${provided}`;
  if (replayCache.has(replayKey)) return { ok: false, reason: 'replay' };
  replayCache.set(replayKey, t);
  return { ok: true };
}

export function webhookTimestamp(payload: WebhookPayload, now = Date.now()): Date {
  if (payload.timestamp) {
    const d = new Date(payload.timestamp);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(now);
}

/**
 * Convert a verified webhook payload into a normalized source item.
 */
export function webhookToItem(payload: WebhookPayload, now = Date.now()): SourceItemInput {
  const title = normalizeTitle(payload.title);
  const content = payload.content ?? payload.body_text ?? '';
  return {
    rawUrl: payload.url ?? 'manual',
    title,
    bodyText: normalizeText(`${title ?? ''} ${content}`),
    publishedAt: webhookTimestamp(payload, now),
    lang: payload.lang,
    metadata: { inbound: true },
  };
}

/**
 * Manual connector: paste text or a URL in the dashboard (the CO-PILOT entry
 * point). When a URL is given, the body is empty and the harvester fetches it.
 */
export function manualToItem(input: { url?: string; text?: string; title?: string }): SourceItemInput {
  const title = normalizeTitle(input.title);
  const text = input.text ?? '';
  const body = title ? `${title} ${text}` : text;
  return {
    rawUrl: input.url ?? 'manual',
    title,
    bodyText: normalizeText(body),
    metadata: { manual: true },
  };
}
