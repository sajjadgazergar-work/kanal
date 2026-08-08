import { describe, expect, it } from 'vitest';
import { checkAdapter, checkDescriptor } from '@kanal/adapters-core';
import { TELEGRAM_DESCRIPTOR } from '../descriptor.js';
import { TelegramAdapter } from '../adapter.js';
import { TelegramClient } from '../client.js';

/**
 * Telegram conformance test (plan §10.2/§10.8): the descriptor must be
 * internally consistent and the adapter must implement every method its
 * descriptor's capabilities imply.
 */

describe('TELEGRAM_DESCRIPTOR', () => {
  it('is internally consistent', () => {
    expect(checkDescriptor(TELEGRAM_DESCRIPTOR)).toEqual([]);
  });

  it('matches the plan §10.3 literal', () => {
    expect(TELEGRAM_DESCRIPTOR.platform).toBe('telegram');
    expect(TELEGRAM_DESCRIPTOR.provenance).toBe('static');
    expect(TELEGRAM_DESCRIPTOR.limits.textMaxChars).toBe(4096);
    expect(TELEGRAM_DESCRIPTOR.limits.captionMaxChars).toBe(1024);
    expect(TELEGRAM_DESCRIPTOR.limits.mediaGroupMax).toBe(10);
    expect(TELEGRAM_DESCRIPTOR.limits.deleteWindowSeconds).toBe(48 * 3600);
    expect(TELEGRAM_DESCRIPTOR.limits.editWindowSeconds).toBe(-1);
    expect(TELEGRAM_DESCRIPTOR.limits.globalSendPerSecond).toBe(30);
    expect(TELEGRAM_DESCRIPTOR.limits.perChatSendPerSecond).toBe(1);
    expect(TELEGRAM_DESCRIPTOR.limits.perGroupSendPerMinute).toBe(20);
    expect(TELEGRAM_DESCRIPTOR.capabilities.has('post.text')).toBe(true);
    expect(TELEGRAM_DESCRIPTOR.capabilities.has('markup.html')).toBe(true);
    expect(TELEGRAM_DESCRIPTOR.capabilities.has('read.post_views')).toBe(false); // sidecar-only
  });

  it('the adapter conforms to the descriptor', () => {
    const adapter = new TelegramAdapter(new TelegramClient({ botToken: 'x' }));
    expect(checkAdapter(adapter, TELEGRAM_DESCRIPTOR)).toEqual([]);
    expect(adapter.kind).toBe('telegram');
  });
});
