import type { ChannelRef, RateLimiter } from '@kanal/adapters-core';
import type { CapabilityDescriptor } from '@kanal/adapters-core';

/**
 * Token-bucket rate limiting (plan §10.4).
 *
 * Three token buckets, checked before every send:
 *
 *   | Bucket      | Capacity | Refill        | Margin vs. stated |
 *   |-------------|----------|---------------|-------------------|
 *   | Global      | 30       | 25/s          | 17%               |
 *   | Per chat    | 1        | 0.8/s         | 20%               |
 *   | Per group   | 20       | 16/min        | 20%               |
 *
 * In production these buckets live in Redis, mutated by one Lua script per
 * send so check-and-consume is atomic across workers (§10.4). This in-process
 * implementation is the reference for the script and the unit-tested core of
 * the AIMD adaptation; the Redis-backed limiter reuses the same math.
 *
 * AIMD adaptation (plan A13, §10.4):
 *   - On any 429: read `parameters.retry_after`, block the scope for
 *     `retry_after + jitter(0..500ms)`, and multiply the refill rate by 0.8,
 *     floored at 25% of the configured rate.
 *   - Recovery: every 30 s without a 429, multiply refill by 1.05, capped at
 *     the configured rate.
 */

interface Bucket {
  capacity: number;
  /** configured refill, in tokens per second (perGroupSendPerMinute / 60) */
  configuredRate: number;
  /** current effective refill, in tokens per second (AIMD-adapted) */
  rate: number;
  tokens: number;
  lastRefillAt: number;
  /** block the scope until this ms epoch when a 429 was seen */
  blockedUntil: number;
  /** last 429 at this ms epoch, or -1 when no backoff is recorded in this cycle */
  lastBackoffAt: number;
}

type BucketScope = 'global' | 'chat' | 'group';

export interface RateLimiterOptions {
  globalPerSecond: number;
  perChatPerSecond: number;
  perGroupPerMinute: number | null;
  /** jitter added to blocked_until on 429 (ms) */
  maxJitterMs?: number;
  /** ms of sustained success that multiplies refill by 1.05 */
  recoveryWindowMs?: number;
  now?: () => number;
}

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

const DEFAULT_JITTER_MS = 500;
const DEFAULT_RECOVERY_WINDOW_MS = 30_000;
const FLOOR_RATIO = 0.25;
const BACKOFF_MULTIPLIER = 0.8;
const RECOVERY_MULTIPLIER = 1.05;
/** Sentinel: no backoff has been recorded in the current recovery cycle. */
const NO_BACKOFF = -1;

export class TokenBucketRateLimiter implements RateLimiter {
  private readonly global: Bucket;
  private readonly chats = new Map<string, Bucket>();
  private readonly groups = new Map<string, Bucket>();
  private readonly opts: Required<RateLimiterOptions>;

  constructor(opts: RateLimiterOptions) {
    this.opts = {
      globalPerSecond: opts.globalPerSecond,
      perChatPerSecond: opts.perChatPerSecond,
      perGroupPerMinute: opts.perGroupPerMinute,
      maxJitterMs: opts.maxJitterMs ?? DEFAULT_JITTER_MS,
      recoveryWindowMs: opts.recoveryWindowMs ?? DEFAULT_RECOVERY_WINDOW_MS,
      now: opts.now ?? defaultNow,
    };
    this.global = this.newBucket(this.opts.globalPerSecond, this.opts.globalPerSecond);
  }

  private newBucket(capacity: number, rate: number): Bucket {
    return {
      capacity,
      configuredRate: rate,
      rate,
      tokens: capacity,
      lastRefillAt: this.opts.now(),
      blockedUntil: 0,
      lastBackoffAt: NO_BACKOFF,
    };
  }

  private bucketFor(scope: BucketScope, channel: ChannelRef): Bucket | null {
    if (scope === 'global') return this.global;
    if (scope === 'chat') {
      let b = this.chats.get(channel.platformChannelId);
      if (!b) {
        b = this.newBucket(1, this.opts.perChatPerSecond);
        this.chats.set(channel.platformChannelId, b);
      }
      return b;
    }
    // group
    const groupId = channel.isGroup ? channel.platformChannelId : null;
    if (!groupId || this.opts.perGroupPerMinute === null) return null;
    let b = this.groups.get(groupId);
    if (!b) {
      b = this.newBucket(1, this.opts.perGroupPerMinute / 60);
      this.groups.set(groupId, b);
    }
    return b;
  }

  /**
   * Refill tokens by elapsed time and apply the AIMD recovery clock: every
   * `recoveryWindowMs` without a 429, multiply the refill by 1.05 (capped at
   * the configured rate). Called lazily from `allow`/`noteSuccess`.
   */
  private refillAndRecover(bucket: Bucket): void {
    const now = this.opts.now();
    const elapsed = (now - bucket.lastRefillAt) / 1000;
    if (elapsed > 0) {
      bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.rate);
      bucket.lastRefillAt = now;
    }
    if (bucket.lastBackoffAt !== NO_BACKOFF && now - bucket.lastBackoffAt >= this.opts.recoveryWindowMs) {
      bucket.rate = Math.min(bucket.configuredRate, bucket.rate * RECOVERY_MULTIPLIER);
      // Start the next recovery window; keep recovering until the 429 stops.
      bucket.lastBackoffAt = now;
    }
  }

  private drainOne(bucket: Bucket): boolean {
    this.refillAndRecover(bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  async allow(channel: ChannelRef): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const now = this.opts.now();
    const scopes: BucketScope[] = ['global', 'chat', ...(channel.isGroup ? (['group'] as const) : [])];
    for (const scope of scopes) {
      const bucket = this.bucketFor(scope, channel);
      if (!bucket) continue;
      if (bucket.blockedUntil > now) {
        return { allowed: false, retryAfterMs: Math.max(0, bucket.blockedUntil - now) };
      }
      this.refillAndRecover(bucket);
      if (!this.drainOne(bucket)) {
        return { allowed: false, retryAfterMs: 0 };
      }
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  noteBackoff(scope: BucketScope, channel: ChannelRef, retryAfterSeconds: number): void {
    const bucket = this.bucketFor(scope, channel);
    if (!bucket) return;
    const now = this.opts.now();
    const jitter = Math.random() * this.opts.maxJitterMs;
    bucket.blockedUntil = now + retryAfterSeconds * 1000 + jitter;
    bucket.lastBackoffAt = now;
    // AIMD multiplicative decrease: 0.8x, floored at 25% of configured rate.
    bucket.rate = Math.max(
      bucket.configuredRate * FLOOR_RATIO,
      bucket.rate * BACKOFF_MULTIPLIER,
    );
    bucket.tokens = 0;
    bucket.lastRefillAt = now;
  }

  noteSuccess(channel: ChannelRef): void {
    // A successful send starts/steps the recovery clock; the actual rate bump
    // happens lazily in `refillAndRecover` once the window elapses.
    const scopes: BucketScope[] = ['global', 'chat', ...(channel.isGroup ? (['group'] as const) : [])];
    for (const scope of scopes) {
      const bucket = this.bucketFor(scope, channel);
      if (!bucket) continue;
      this.refillAndRecover(bucket);
    }
  }

  /** The current effective per-second rates, for the UI (§10.4). */
  effectiveRates(): Record<'global' | string, number> {
    const out: Record<string, number> = { global: this.global.rate };
    for (const [id, b] of this.chats) out[`chat:${id}`] = b.rate;
    for (const [id, b] of this.groups) out[`group:${id}`] = b.rate;
    return out;
  }
}

/** Build the limiter from a CapabilityDescriptor's limits. */
export function limiterFromDescriptor(descriptor: CapabilityDescriptor): TokenBucketRateLimiter {
  return new TokenBucketRateLimiter({
    globalPerSecond: descriptor.limits.globalSendPerSecond,
    perChatPerSecond: descriptor.limits.perChatSendPerSecond,
    perGroupPerMinute: descriptor.limits.perGroupSendPerMinute,
  });
}
