import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { processItem, urlHashOf } from '../pipeline.js';
import { verifyWebhookSignature, webhookToItem, manualToItem, resetReplayCache } from '../connectors/inbound.js';
import { NOW } from './helpers.js';

beforeEach(() => {
  // The replay cache is module-global; without resetting, two webhook tests in
  // the same second would false-positive as replays of each other.
  resetReplayCache();
});

describe('processItem', () => {
  it('canonicalizes, hashes, and freshness-scores an item', () => {
    const item = processItem(
      {
        rawUrl: 'HTTPS://Example.COM/News?utm_source=rss&a=1&fbclid=x#frag',
        title: '  A   Title  ',
        bodyText: 'Body with\n\n newlines   and zero-width​ chars',
        publishedAt: new Date(NOW.getTime() - 2 * 3600000),
      },
      { now: NOW },
    );
    expect(item.canonicalUrl).toBe('https://example.com/News?a=1');
    expect(item.urlHash).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(item.bodySha256).toMatch(/^[0-9a-f]{8}-/);
    expect(item.title).toBe('A Title');
    expect(item.bodyText).toBe('Body with newlines and zero-width chars');
    expect(item.simhash).toBeTruthy();
    expect(item.freshness.confidence).toBe('high');
    expect(item.freshness.basis).toBe('published_at');
  });

  it('marks low confidence when publishedAt is missing', () => {
    const item = processItem({ rawUrl: 'https://example.com/x', bodyText: 'x', title: 't' }, { now: NOW });
    expect(item.freshness.confidence).toBe('low');
    expect(item.freshness.basis).toBe('first_seen_at');
  });

  it('urlHashOf matches processItem canonicalization', () => {
    const processed = processItem({ rawUrl: 'https://example.com/a?utm_source=x&z=1', bodyText: 'x' }, { now: NOW });
    expect(urlHashOf('https://example.com/a?z=1')).toBe(processed.urlHash);
  });
});

describe('webhook connector (attack #8)', () => {
  const secret = 'test-secret';
  const rawBody = JSON.stringify({ url: 'https://example.test/w', title: 'Webhook item', content: 'body' });

  function sign(body: string, t: number, sec: string): string {
    // HMAC over `t.<rawBody>`, Telegram-style signature header
    const mac = createHmac('sha256', sec).update(`${t}.${body}`).digest('hex');
    return `t=${t},v1=${mac}`;
  }

  it('accepts a valid signature within the window', () => {
    const t = Math.floor(Date.now() / 1000);
    const header = sign(rawBody, t, secret);
    expect(verifyWebhookSignature(rawBody, header, secret).ok).toBe(true);
  });

  it('rejects a bad signature', () => {
    const t = Math.floor(Date.now() / 1000);
    const header = sign(rawBody, t, 'wrong-secret');
    expect(verifyWebhookSignature(rawBody, header, secret).ok).toBe(false);
  });

  it('rejects a stale timestamp', () => {
    const t = Math.floor(Date.now() / 1000) - 600; // 10 min ago
    const header = sign(rawBody, t, secret);
    expect(verifyWebhookSignature(rawBody, header, secret).ok).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifyWebhookSignature(rawBody, null, secret).ok).toBe(false);
  });

  it('rejects a replay', () => {
    const t = Math.floor(Date.now() / 1000);
    const header = sign(rawBody, t, secret);
    expect(verifyWebhookSignature(rawBody, header, secret).ok).toBe(true);
    expect(verifyWebhookSignature(rawBody, header, secret).ok).toBe(false); // replay
  });

  it('converts a verified payload to an item', () => {
    const item = webhookToItem(JSON.parse(rawBody) as { url: string; title: string; content: string }, NOW);
    expect(item.rawUrl).toBe('https://example.test/w');
    expect(item.bodyText).toContain('Webhook item');
  });
});

describe('manual connector', () => {
  it('creates an item from pasted text', () => {
    const item = manualToItem({ text: '  Note body ', title: 'Note' });
    expect(item.bodyText).toBe('Note Note body');
    expect(item.rawUrl).toBe('manual');
  });
});
