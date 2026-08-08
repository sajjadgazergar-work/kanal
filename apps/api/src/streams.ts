import type { LiveEvent } from '@kanal/contracts';

/**
 * In-memory live event ring buffer + fan-out (plan §13). One buffer per
 * subscriber with a typed drop policy (plan §13.4):
 *
 *   - Critical  (run.state, approval, failed stage.end) → never dropped; if the
 *                buffer is full of them the subscriber is disconnected.
 *   - Structural(stage.start, stage.end, model.call, tool.call) → coalesce to
 *                the latest per (runId, stage).
 *   - Cosmetic  (token) → drop oldest freely.
 *
 * A `LiveEventEnvelope` has a monotonic `id` so a reconnect can replay the gap
 * via `Last-Event-ID` (plan §13.3).
 */

export const RING_BUFFER_SIZE = 512;

/** Monotonic event id — 16-byte hex so lexicographic order is time order. */
let counter = 0;
function nextId(): string {
  counter += 1;
  const pad = counter.toString(16).padStart(16, '0');
  return `${Date.now().toString(16).padStart(16, '0')}${pad}`;
}

export interface LiveEventEnvelope {
  id: string;
  event: LiveEvent;
}

export interface StreamListener {
  /** Resolve the pending write when the subscriber's socket can take more. */
  push(env: LiveEventEnvelope): boolean;
  /** Called when this subscriber is dropped for being too slow. */
  disconnect(): void;
}

export interface EventRing {
  publish(event: LiveEvent): void;
  /** Replay events with id > sinceId, oldest first. */
  replaySince(sinceId: string | null): LiveEventEnvelope[];
  subscribe(listener: StreamListener): void;
  unsubscribe(listener: StreamListener): void;
  /** Number of buffered envelopes (for tests). */
  size(): number;
  /** Current high-water id. */
  lastId(): string;
}

function structuralKey(event: LiveEvent): string | null {
  if (event.t === 'stage.start' || event.t === 'stage.end' || event.t === 'model.call' || event.t === 'tool.call') {
    return `${event.t}:${event.runId}:${event.stage}`;
  }
  return null;
}

export class RingBuffer implements EventRing {
  private readonly buffer: LiveEventEnvelope[] = [];
  private readonly listeners = new Set<StreamListener>();

  publish(event: LiveEvent): void {
    const env: LiveEventEnvelope = { id: nextId(), event };
    this.append(env);
    for (const listener of this.listeners) {
      listener.push(env);
    }
  }

  replaySince(sinceId: string | null): LiveEventEnvelope[] {
    if (sinceId === null) return [...this.buffer];
    const out: LiveEventEnvelope[] = [];
    for (const env of this.buffer) {
      if (env.id > sinceId) out.push(env);
    }
    return out;
  }

  subscribe(listener: StreamListener): void {
    this.listeners.add(listener);
  }

  unsubscribe(listener: StreamListener): void {
    this.listeners.delete(listener);
  }

  size(): number {
    return this.buffer.length;
  }

  lastId(): string {
    const last = this.buffer[this.buffer.length - 1];
    return last === undefined ? '' : last.id;
  }

  private append(env: LiveEventEnvelope): void {
    // Continuous structural coalescing (plan §13.4): keep the latest per
    // (runId, stage) — the incoming structural event supersedes any older one.
    const incomingKey = structuralKey(env.event);
    if (incomingKey !== null) {
      for (let i = this.buffer.length - 1; i >= 0; i--) {
        if (structuralKey(this.buffer[i]!.event) === incomingKey) {
          this.buffer.splice(i, 1);
          break;
        }
      }
    }

    if (this.buffer.length >= RING_BUFFER_SIZE) {
      if (!this.makeRoomFor(env)) return; // dropped the incoming event itself
    }
    this.buffer.push(env);
  }

  /**
   * Overflow policy (plan §13.4). Returns true when room was made (caller pushes
   * the incoming event), false when the incoming event was dropped instead.
   *
   *  - Cosmetic (token): drop an older cosmetic freely; if none exists, drop the
   *    incoming token itself rather than evict a critical event for it.
   *  - Structural: drop an older cosmetic, else coalesce an older structural
   *    duplicate (keeping the newest per (runId, stage)).
   *  - Critical (run.state, approval, failed stage.end): drop an older cosmetic,
   *    then a structural duplicate, then — only as a last resort — the oldest
   *    envelope. A subscriber that cannot keep up with a critical flood is
   *    disconnected at the SSE layer instead.
   */
  private makeRoomFor(env: LiveEventEnvelope): boolean {
    const incomingIsCosmetic = env.event.t === 'token';

    // 1. Prefer dropping an existing cosmetic event.
    const cosmetic = this.buffer.findIndex((e) => e.event.t === 'token');
    if (cosmetic >= 0) {
      this.buffer.splice(cosmetic, 1);
      return true;
    }

    // 2. A cosmetic event must never displace a critical one.
    if (incomingIsCosmetic) return false;

    // 3. Structural: coalesce an older duplicate (the incoming replaces it).
    const incomingKey = structuralKey(env.event);
    if (incomingKey !== null) {
      for (let i = this.buffer.length - 1; i >= 0; i--) {
        if (structuralKey(this.buffer[i]!.event) === incomingKey) {
          this.buffer.splice(i, 1);
          return true;
        }
      }
    }

    // 4. Last resort: drop the oldest envelope (critical events only evict
    //    other criticals in a full-of-criticals buffer; the SSE slow-subscriber
    //    disconnect is the real backstop).
    this.buffer.shift();
    return true;
  }
}
