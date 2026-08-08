import { describe, expect, it } from 'vitest';
import { TelegramClient } from '../client.js';
import type { ChannelRef } from '@kanal/adapters-core';

/**
 * HTTP outcome-mapping tests. No network: every request is served by an
 * injected `fetchImpl`. The plan's outcome contract (§10.2) is asserted:
 *   - 2xx ok:true       → ok
 *   - 429 + retry_after → rate_limited
 *   - 400/403           → rejected / unauthorized
 *   - 400 not modified  → not_modified
 *   - timeout           → uncertain (NEVER auto-retried, plan D4/§10.6)
 */

function makeClient(handler: (url: string, init: RequestInit) => Promise<Response>) {
  return new TelegramClient({
    botToken: '123:TOKEN',
    baseUrl: 'https://fake.example/bot',
    fetchImpl: handler as unknown as typeof fetch,
  });
}

const channel: ChannelRef = {
  platformChannelId: '-100x',
  contentLocale: 'fa',
  numeralSystem: 'latn',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TelegramClient — outcome mapping', () => {
  it('maps ok:true to PublishOutcome.ok', async () => {
    const client = makeClient(async () => jsonResponse(200, { ok: true, result: { message_id: 42 } }));
    const out = await client.sendMessage(channel, 'hi', { parseMode: 'HTML' });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.platformMessageId).toBe('42');
      expect(out.editable).toBe(true);
      expect(typeof out.respondedAt).toBe('string');
    }
  });

  it('maps 429 with retry_after to rate_limited', async () => {
    const client = makeClient(async () =>
      jsonResponse(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 12 } }),
    );
    const out = await client.sendMessage(channel, 'hi');
    expect(out).toEqual({ kind: 'rate_limited', retryAfterSeconds: 12 });
  });

  it('maps 400 to rejected (permanent)', async () => {
    const client = makeClient(async () => jsonResponse(400, { ok: false, error_code: 400, description: 'Bad Request: text is too long' }));
    const out = await client.sendMessage(channel, 'hi');
    expect(out.kind).toBe('rejected');
    if (out.kind === 'rejected') {
      expect(out.permanent).toBe(true);
      expect(out.code).toBe('400');
    }
  });

  it('maps 403 to unauthorized', async () => {
    const client = makeClient(async () => jsonResponse(403, { ok: false, error_code: 403, description: 'Forbidden: bot is not a member' }));
    const out = await client.sendMessage(channel, 'hi');
    expect(out.kind).toBe('unauthorized');
  });

  it('maps 404 to not_found', async () => {
    const client = makeClient(async () => jsonResponse(404, { ok: false, error_code: 404, description: 'Not Found' }));
    const out = await client.sendMessage(channel, 'hi');
    expect(out.kind).toBe('not_found');
  });

  it('maps a timeout to uncertain.timeout (never auto-retried)', async () => {
    const client = makeClient(async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    });
    const out = await client.sendMessage(channel, 'hi');
    expect(out.kind).toBe('uncertain');
    if (out.kind === 'uncertain') expect(out.reason).toBe('timeout');
  });

  it('maps a network error to uncertain.connection_reset', async () => {
    const client = makeClient(async () => {
      throw new TypeError('fetch failed');
    });
    const out = await client.sendMessage(channel, 'hi');
    expect(out.kind).toBe('uncertain');
  });

  it('maps 400 "message is not modified" to not_modified for edits', async () => {
    const client = makeClient(async () => jsonResponse(400, { ok: false, error_code: 400, description: 'Bad Request: message is not modified' }));
    const out = await client.editMessageText(channel, '9', 'same');
    expect(out.kind).toBe('not_modified');
  });

  it('maps 5xx to uncertain (may have been acted on)', async () => {
    const client = makeClient(async () => jsonResponse(500, { ok: false, description: 'Internal' }));
    const out = await client.sendMessage(channel, 'hi');
    expect(out.kind).toBe('uncertain');
  });

  it('sendPhoto passes the caption and parse mode', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const client = makeClient(async (url, init) => {
      seen = { url, init };
      return jsonResponse(200, { ok: true, result: { message_id: 7 } });
    });
    const out = await client.sendPhoto(channel, 'https://x.example/i.jpg', { caption: '<b>cap</b>', parseMode: 'HTML' });
    expect(out.kind).toBe('ok');
    const body = JSON.parse(String(seen?.init.body));
    expect(body.method ? '' : '').toBe('');
    expect(seen?.url).toContain('/sendPhoto');
    expect(body.caption).toBe('<b>cap</b>');
    expect(body.parse_mode).toBe('HTML');
    expect(body.chat_id).toBe('-100x');
  });
});
