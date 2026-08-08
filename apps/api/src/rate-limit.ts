import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * In-memory token bucket (plan §12.7: "Rate limiter ... only", and the Redis
 * escape hatch is pre-designed, not pre-built — D6). Per-key buckets with
 * exponential refill. Not a durability dependency: a restart simply resets the
 * buckets.
 */

export interface TokenBucketOptions {
  /** Max burst capacity (tokens). */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class TokenBucket {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  readonly refillPerSec: number;

  constructor(opts: TokenBucketOptions) {
    this.capacity = opts.capacity;
    this.refillPerSec = opts.refillPerSec;
  }

  /**
   * Try to consume one token.
   * Returns `{ allowed: true, remaining }` on success, or
   * `{ allowed: false, remaining: 0 }` when the bucket is empty.
   */
  tryConsume(key: string, now: number = Date.now()): { allowed: boolean; remaining: number } {
    const nowSec = now / 1000;
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: this.capacity, lastRefill: nowSec };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, nowSec - bucket.lastRefill);
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerSec);
      bucket.lastRefill = nowSec;
    }
    if (bucket.tokens < 1) return { allowed: false, remaining: 0 };
    bucket.tokens -= 1;
    return { allowed: true, remaining: bucket.tokens };
  }

  /** Drop the stored buckets (used by tests and health teardown). */
  clear(): void {
    this.buckets.clear();
  }
}

/** Key derivation for the rate limiter. */
export function keyFor(request: FastifyRequest): string {
  return request.ip;
}

/**
 * Fastify pre-handler that applies the bucket to the request's key. On
 * exhaustion replies 429 with a `Retry-After` header.
 */
export function rateLimit(bucket: TokenBucket, name = 'rate') {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { allowed } = bucket.tryConsume(keyFor(request));
    if (!allowed) {
      await reply
        .header('Retry-After', String(Math.ceil(1 / bucket.refillPerSec)))
        .code(429)
        .send({ error: 'rate_limited', message: `${name} limit exceeded` });
    }
  };
}
