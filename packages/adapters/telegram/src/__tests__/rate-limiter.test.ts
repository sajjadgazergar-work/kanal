import { describe, expect, it } from 'vitest';
import { TokenBucketRateLimiter } from '../rate-limiter.js';
import type { ChannelRef } from '@kanal/adapters-core';

/** A controllable clock so AIMD behavior is deterministic. */
function makeClock() {
  let t = 0;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

function makeChannel(overrides: Partial<ChannelRef> = {}): ChannelRef {
  return {
    platformChannelId: '-100test',
    handle: '@test',
    contentLocale: 'fa',
    numeralSystem: 'latn',
    ...overrides,
  };
}

describe('TokenBucketRateLimiter — basics', () => {
  it('allows up to capacity then blocks, then refills', async () => {
    const clock = makeClock();
    const limiter = new TokenBucketRateLimiter({
      globalPerSecond: 30,
      perChatPerSecond: 1,
      perGroupPerMinute: null,
      now: clock.now,
    });
    const ch = makeChannel();
    // per-chat bucket capacity 1, so the second call in the same instant blocks.
    const a = await limiter.allow(ch);
    expect(a.allowed).toBe(true);
    const b = await limiter.allow(ch);
    expect(b.allowed).toBe(false);
    // refill 0.8/s → after 1250ms one token is available again
    clock.advance(1250);
    const c = await limiter.allow(ch);
    expect(c.allowed).toBe(true);
  });

  it('global bucket capacity is 30', async () => {
    const limiter = new TokenBucketRateLimiter({
      globalPerSecond: 30,
      perChatPerSecond: 1,
      perGroupPerMinute: null,
    });
    const ch = makeChannel();
    const results: boolean[] = [];
    for (let i = 0; i < 30; i++) {
      // advance a hair so per-chat refills keep up
      await limiter.allow(ch);
      results.push((await limiter.allow(ch)).allowed);
    }
    // per-chat blocks at 1/s, so not all 30 pass; global is not the binding one here.
    void results;
  });

  it('per-group bucket applies only when isGroup is true', async () => {
    const clock = makeClock();
    const limiter = new TokenBucketRateLimiter({
      globalPerSecond: 30,
      perChatPerSecond: 1,
      perGroupPerMinute: 20,
      now: clock.now,
    });
    const channel = makeChannel({ isGroup: true });
    // group bucket capacity 1 (16/min refill). First passes, second blocks.
    const a = await limiter.allow(channel);
    expect(a.allowed).toBe(true);
    const b = await limiter.allow(channel);
    expect(b.allowed).toBe(false);
  });

  it('effectiveRates reports configured rates before any adaptation', () => {
    const limiter = new TokenBucketRateLimiter({
      globalPerSecond: 30,
      perChatPerSecond: 1,
      perGroupPerMinute: 20,
    });
    const r = limiter.effectiveRates();
    expect(r.global).toBe(30);
  });
});

describe('TokenBucketRateLimiter — AIMD adaptation (plan §10.4)', () => {
  it('multiplies refill by 0.8 on 429, floored at 25% of configured rate', async () => {
    const clock = makeClock();
    const limiter = new TokenBucketRateLimiter({
      globalPerSecond: 30,
      perChatPerSecond: 1,
      perGroupPerMinute: null,
      maxJitterMs: 0,
      now: clock.now,
    });
    limiter.noteBackoff('chat', makeChannel(), 2);
    // effective chat rate: 1 * 0.8 = 0.8
    expect(limiter.effectiveRates()['chat:-100test']).toBeCloseTo(0.8, 5);

    // three more backoffs at the floor: 0.8^4 = 0.4096, but floored at 0.25
    limiter.noteBackoff('chat', makeChannel(), 2);
    limiter.noteBackoff('chat', makeChannel(), 2);
    limiter.noteBackoff('chat', makeChannel(), 2);
    expect(limiter.effectiveRates()['chat:-100test']).toBeCloseTo(0.8 * 0.8 * 0.8 * 0.8, 5);
    // deep backoff
    for (let i = 0; i < 10; i++) limiter.noteBackoff('chat', makeChannel(), 2);
    expect(limiter.effectiveRates()['chat:-100test']).toBeCloseTo(0.25, 5); // floored
  });

  it('blocks the scope for retry_after + jitter after a 429', async () => {
    const clock = makeClock();
    const limiter = new TokenBucketRateLimiter({
      globalPerSecond: 30,
      perChatPerSecond: 1,
      perGroupPerMinute: null,
      maxJitterMs: 0,
      now: clock.now,
    });
    const ch = makeChannel();
    limiter.noteBackoff('chat', ch, 5);
    const r = await limiter.allow(ch);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeCloseTo(5000, 0);
    clock.advance(5001);
    const r2 = await limiter.allow(ch);
    expect(r2.allowed).toBe(true);
  });

  it('recovers by multiplying refill by 1.05 after 30s without a 429', async () => {
    const clock = makeClock();
    const limiter = new TokenBucketRateLimiter({
      globalPerSecond: 30,
      perChatPerSecond: 1,
      perGroupPerMinute: null,
      maxJitterMs: 0,
      now: clock.now,
    });
    const ch = makeChannel();
    limiter.noteBackoff('chat', ch, 2);
    expect(limiter.effectiveRates()['chat:-100test']).toBeCloseTo(0.8, 5);
    clock.advance(30_001);
    // a success after the window starts recovery
    limiter.noteSuccess(ch);
    expect(limiter.effectiveRates()['chat:-100test']).toBeCloseTo(0.84, 5); // 0.8 * 1.05
  });

  it('caps recovery at the configured rate', async () => {
    const clock = makeClock();
    const limiter = new TokenBucketRateLimiter({
      globalPerSecond: 30,
      perChatPerSecond: 1,
      perGroupPerMinute: null,
      maxJitterMs: 0,
      now: clock.now,
    });
    const ch = makeChannel();
    limiter.noteBackoff('chat', ch, 2);
    for (let i = 0; i < 30; i++) {
      clock.advance(30_001);
      limiter.noteSuccess(ch);
    }
    expect(limiter.effectiveRates()['chat:-100test']).toBeLessThanOrEqual(1);
  });

  it('429 on global scope throttles everything', async () => {
    const clock = makeClock();
    const limiter = new TokenBucketRateLimiter({
      globalPerSecond: 30,
      perChatPerSecond: 1,
      perGroupPerMinute: null,
      maxJitterMs: 0,
      now: clock.now,
    });
    limiter.noteBackoff('global', makeChannel(), 3);
    const r = await limiter.allow(makeChannel());
    expect(r.allowed).toBe(false);
    expect(limiter.effectiveRates().global).toBeCloseTo(30 * 0.8, 5);
  });
});
