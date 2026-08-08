import { describe, it, expect } from 'vitest';
import { TokenBucket } from '../src/rate-limit.js';
import { safeEqual, extractBearer } from '../src/auth.js';

describe('TokenBucket', () => {
  it('allows bursts up to capacity then blocks', () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSec: 0.1 });
    expect(bucket.tryConsume('k', 0)).toEqual({ allowed: true, remaining: 2 });
    expect(bucket.tryConsume('k', 0)).toEqual({ allowed: true, remaining: 1 });
    expect(bucket.tryConsume('k', 0)).toEqual({ allowed: true, remaining: 0 });
    expect(bucket.tryConsume('k', 0)).toEqual({ allowed: false, remaining: 0 });
  });

  it('refills over time', () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSec: 1 });
    bucket.tryConsume('k', 0);
    bucket.tryConsume('k', 0);
    bucket.tryConsume('k', 0);
    expect(bucket.tryConsume('k', 0).allowed).toBe(false);
    // 1.5s later → 1.5 tokens accumulated → at least 1 token.
    expect(bucket.tryConsume('k', 1500).allowed).toBe(true);
  });

  it('keeps keys independent', () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSec: 0 });
    expect(bucket.tryConsume('a', 0).allowed).toBe(true);
    expect(bucket.tryConsume('a', 0).allowed).toBe(false);
    expect(bucket.tryConsume('b', 0).allowed).toBe(true);
  });

  it('never exceeds capacity', () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSec: 10 });
    bucket.tryConsume('k', 0);
    const { remaining } = bucket.tryConsume('k', 10_000);
    expect(remaining).toBe(1); // capped at capacity-1
  });
});

describe('auth helpers (plan §20.1)', () => {
  it('safeEqual matches identical keys and rejects different ones', () => {
    expect(safeEqual('secret-key', 'secret-key')).toBe(true);
    expect(safeEqual('secret-key', 'secret-keY')).toBe(false);
    expect(safeEqual('short', 'a-longer-secret')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('extractBearer pulls the token from the Authorization header', () => {
    const req = { headers: { authorization: 'Bearer abc123' } } as Parameters<typeof extractBearer>[0];
    expect(extractBearer(req)).toBe('abc123');
    const none = { headers: {} } as Parameters<typeof extractBearer>[0];
    expect(extractBearer(none)).toBeNull();
    const bad = { headers: { authorization: 'Basic abc' } } as Parameters<typeof extractBearer>[0];
    expect(extractBearer(bad)).toBeNull();
  });
});
