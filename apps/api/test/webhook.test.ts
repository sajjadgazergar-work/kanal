import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { buildServer } from '../src/server.js';
import { FakeRunner } from './fake-runner.js';
import {
  computeSignature,
  parseSignatureHeader,
  safeHexEqual,
  ReplayCache,
} from '../src/routes/webhook.js';

const API_KEY = 'test-secret-key-1234567890';
const SOURCE_ID = 'src-123';
const SECRET = 'whsec_per_source_secret';

function makeSignatureHeader(timestamp: number, body: string, secret = SECRET): string {
  const payload = `${timestamp}.${body}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

function makeApp(overrides: Partial<Parameters<typeof buildServer>[0]> = {}, now = () => Date.now()): FastifyInstance {
  const runner = new FakeRunner();
  return buildServer({
    apiKey: API_KEY,
    runner,
    webhookSecrets: {
      async getSecret(id: string) {
        return id === SOURCE_ID ? SECRET : null;
      },
    },
    pingDb: async () => true,
    logger: false,
    ...overrides,
  });
}

describe('webhook HMAC verification (plan §19 row 8)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = makeApp();
  });

  it('accepts a correctly signed delivery', async () => {
    const body = JSON.stringify({ title: 'hello', url: 'https://example.com' });
    const ts = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sources/${SOURCE_ID}/webhook`,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
        'kanal-signature': makeSignatureHeader(ts, body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().ok).toBe(true);
    await app.close();
  });

  it('rejects a tampered body', async () => {
    const body = JSON.stringify({ title: 'hello' });
    const ts = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sources/${SOURCE_ID}/webhook`,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
        'kanal-signature': makeSignatureHeader(ts, body),
      },
      payload: JSON.stringify({ title: 'tampered' }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_signature');
    await app.close();
  });

  it('rejects a stale timestamp outside the 5-minute window', async () => {
    const body = JSON.stringify({ title: 'hello' });
    const ts = Date.now() - 10 * 60 * 1000;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sources/${SOURCE_ID}/webhook`,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
        'kanal-signature': makeSignatureHeader(ts, body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('stale_signature');
    await app.close();
  });

  it('rejects a missing signature header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sources/${SOURCE_ID}/webhook`,
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects an unknown source', async () => {
    const body = JSON.stringify({ title: 'hello' });
    const ts = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sources/unknown/webhook',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
        'kanal-signature': makeSignatureHeader(ts, body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('replays a signature and eats the duplicate', async () => {
    const body = JSON.stringify({ title: 'hello' });
    const ts = Date.now();
    const header = makeSignatureHeader(ts, body);
    const opts = {
      method: 'POST' as const,
      url: `/api/v1/sources/${SOURCE_ID}/webhook`,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
        'kanal-signature': header,
      },
      payload: body,
    };
    const first = await app.inject(opts);
    expect(first.statusCode).toBe(202);
    const second = await app.inject(opts);
    expect(second.statusCode).toBe(202);
    expect(second.json().replayed).toBe(true);
    await app.close();
  });

  it('calls onVerifiedEvent only for verified deliveries', async () => {
    const seen: Array<{ id: string; payload: unknown }> = [];
    await app.close();
    app = makeApp({
      onWebhookEvent: async (id, payload) => {
        seen.push({ id, payload });
      },
    });
    const body = JSON.stringify({ title: 'hello' });
    const ts = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sources/${SOURCE_ID}/webhook`,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
        'kanal-signature': makeSignatureHeader(ts, body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe(SOURCE_ID);
    await app.close();
  });
});

describe('webhook helpers', () => {
  it('parses the Kanal-Signature header', () => {
    const parsed = parseSignatureHeader('t=1700000000000,v1=deadbeef');
    expect(parsed).toEqual({ signature: 'deadbeef', timestamp: '1700000000000' });
    expect(parseSignatureHeader(undefined)).toBeNull();
    expect(parseSignatureHeader('t=abc,v1=x')).toBeNull();
  });

  it('safeHexEqual compares in constant time and rejects mismatches', () => {
    expect(safeHexEqual('aabb', 'aabb')).toBe(true);
    expect(safeHexEqual('aabb', 'aacc')).toBe(false);
    expect(safeHexEqual('', 'aabb')).toBe(false);
    expect(safeHexEqual('aabb', 'aabbcc')).toBe(false);
  });

  it('computeSignature matches the HMAC over timestamp.body', () => {
    const body = '{"a":1}';
    const ts = '1700000000000';
    const expected = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
    expect(computeSignature(SECRET, `${ts}.${body}`)).toBe(expected);
  });

  it('ReplayCache detects replays and stays bounded', () => {
    const cache = new ReplayCache(2);
    expect(cache.isReplay('a', 's1')).toBe(false);
    cache.markSeen('a', 's1');
    expect(cache.isReplay('a', 's1')).toBe(true);
    expect(cache.isReplay('a', 's2')).toBe(false);
    cache.markSeen('b', 's1');
    cache.markSeen('c', 's1');
    // evicted the oldest
    expect(cache.isReplay('a', 's1')).toBe(false);
  });
});
