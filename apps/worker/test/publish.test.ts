import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveBotToken } from '../src/publish.js';

const ORIG = process.env;

describe('resolveBotToken (plan §10.3)', () => {
  beforeEach(() => {
    process.env = { ...ORIG };
    delete process.env.KANAL_TELEGRAM_BOT_TOKEN;
  });

  afterEach(() => {
    process.env = ORIG;
  });

  it('returns null for an empty credential_ref', () => {
    expect(resolveBotToken('')).toBeNull();
    expect(resolveBotToken(undefined as unknown as string)).toBeNull();
  });

  it('reads a direct env-var named by the credential_ref', () => {
    process.env.MY_CHANNEL_TOKEN = '123:abc';
    expect(resolveBotToken('MY_CHANNEL_TOKEN')).toBe('123:abc');
  });

  it('falls back to KANAL_TELEGRAM_BOT_TOKEN', () => {
    process.env.KANAL_TELEGRAM_BOT_TOKEN = 'fallback:token';
    expect(resolveBotToken('not-a-real-env-var')).toBe('fallback:token');
  });

  it('returns null when neither the ref nor the fallback resolves', () => {
    expect(resolveBotToken('vault:secret/path')).toBeNull();
  });
});
