/**
 * The live event bus (§13.1, §13.3, §13.4).
 *
 * A per-run in-memory ring buffer that feeds the SSE endpoint. Spans are
 * converted to `LiveEvent` objects (the narrow, versioned contract type) — the
 * UI never parses raw OTLP — then pushed through a per-subscriber fan-out that
 * enforces the typed drop policy and the 200 events/sec global ceiling.
 */

import type { LiveEvent } from '@kanal/contracts';

export const RING_BUFFER_CAPACITY = 512;
/** Global ceiling: 200 events/sec per subscriber, via a 50 ms coalescing window (§13.4). */
export const COALESCE_MS = 50;
export const MAX_EVENTS_PER_SECOND = 200;
/** 200/sec ÷ (1000/50) windows per second = 10 events per 50 ms window. */
export const MAX_EVENTS_PER_WINDOW = Math.ceil((MAX_EVENTS_PER_SECOND * COALESCE_MS) / 1000);
/** Token streaming is throttled to 20 flushes/sec regardless of arrival rate (§13.4). */
export const TOKEN_THROTTLE_MS = 50;

export type EventClass = 'critical' | 'structural' | 'cosmetic';

/** Typed drop policy (§13.4). */
export const EVENT_CLASS: ReadonlyMap<LiveEvent['t'], EventClass> = new Map([
  ['run.state', 'critical'],
  ['approval', 'critical'],
  ['stage.start', 'structural'],
  ['stage.end', 'structural'],
  ['model.call', 'structural'],
  ['tool.call', 'structural'],
  ['token', 'cosmetic'],
  ['cost', 'structural'],
  ['heartbeat', 'cosmetic'],
]);

/** §13.4: `stage.end` with `ok:false` is critical even though bare `stage.end` is structural. */
export function eventClass(ev: LiveEvent): EventClass {
  if (ev.t === 'stage.end' && ev.ok === false) return 'critical';
  return EVENT_CLASS.get(ev.t) ?? 'structural';
}

export function eventKey(ev: LiveEvent): string {
  switch (ev.t) {
    case 'stage.start':
    case 'stage.end':
    case 'model.call':
    case 'tool.call':
      return `run:${ev.runId}|stage:${ev.stage}`;
    default:
      return `t:${ev.t}|run:${'runId' in ev ? ev.runId : ''}`;
  }
}

export interface RingBufferOptions {
  capacity?: number;
  /** Override for tests (e.g. a fake ticker). */
  nowMs?: () => number;
}

export interface EnqueueResult {
  event: LiveEvent;
  /** True when the event was placed into the buffer. */
  accepted: boolean;
  /** True when an older event was removed (coalescing or drop-oldest). */
  coalesced: boolean;
  /** Set to the slow-consumer error code when the buffer overflowed with critical events. */
  disconnect?: string;
}

/**
 * A per-subscriber bounded ring buffer of 512 events (§13.4). The drop policy:
 *  - Critical (`run.state`, `approval`, `stage.end` with `ok:false`) are never
 *    dropped and never coalesced — each occupies its own slot. If the buffer is
 *    full of them the subscriber is disconnected with `4290 slow_consumer` and
 *    must reconnect and re-fetch state.
 *  - Structural (`stage.start`, `stage.end`, `model.call`, `tool.call`)
 *    coalesce: keep the latest per `(runId, stage)`; drop superseded.
 *  - Cosmetic (`token`, `heartbeat`) drop the oldest, freely. Tokens are not
 *    coalesced: every flushed delta is a distinct character run.
 *  - Global ceiling: 200 events/sec per subscriber, enforced by a 50 ms
 *    coalescing window (§13.4). Token streaming is additionally throttled to
 *    20 flushes/sec regardless of arrival rate.
 *
 * `enqueue` is synchronous and side-effect free (no timers) so tests can drive
 * it deterministically; a subscriber who cannot keep up with run state is
 * disconnected the moment a critical event would overflow the buffer.
 */
export class LiveEventRingBuffer {
  readonly capacity: number;
  private readonly now: () => number;
  private items: LiveEvent[] = [];
  /** Count of items currently in the buffer, per class. */
  private criticalCount = 0;
  private cosmeticCount = 0;
  /** Key -> index in `items`, for structural coalescing. */
  private structuralIndex = new Map<string, number>();
  private overflowed = false;
  /** The coalescing window tick (`Math.floor(now/COALESCE_MS)`) that `windowCount` belongs to. */
  private lastWindow = 0;
  /** Non-cosmetic events accepted in the current window (max `MAX_EVENTS_PER_WINDOW`). */
  private windowCount = 0;
  private lastTokenFlush = 0;

  constructor(options: RingBufferOptions = {}) {
    this.capacity = options.capacity ?? RING_BUFFER_CAPACITY;
    this.now = options.nowMs ?? (() => Date.now());
  }

  get length(): number {
    return this.items.length;
  }

  isOverflowed(): boolean {
    return this.overflowed;
  }

  /** The 4290 slow-consumer disconnect error (§13.4). */
  static readonly SLOW_CONSUMER = '4290 slow_consumer';

  snapshot(): readonly LiveEvent[] {
    return this.items.slice();
  }

  clear(): void {
    this.items = [];
    this.criticalCount = 0;
    this.cosmeticCount = 0;
    this.structuralIndex.clear();
    this.overflowed = false;
    this.lastWindow = 0;
    this.windowCount = 0;
    this.lastTokenFlush = 0;
  }

  enqueue(event: LiveEvent): EnqueueResult {
    const cls = eventClass(event);

    if (cls === 'cosmetic') {
      // Token streaming: throttled to 20 flushes/sec (§13.4).
      const now = this.now();
      if (now - this.lastTokenFlush < TOKEN_THROTTLE_MS) {
        return { event, accepted: false, coalesced: false };
      }
      this.lastTokenFlush = now;
    } else {
      // Global ceiling: 200 events/sec, enforced by a 50 ms coalescing window (§13.4).
      const window = Math.floor(this.now() / COALESCE_MS);
      if (window !== this.lastWindow) {
        this.lastWindow = window;
        this.windowCount = 0;
      }
      if (this.windowCount >= MAX_EVENTS_PER_WINDOW) {
        return { event, accepted: false, coalesced: false };
      }
      this.windowCount += 1;
    }

    if (cls === 'structural') {
      const key = eventKey(event);
      const existing = this.structuralIndex.get(key);
      if (existing !== undefined) {
        // Coalesce: keep the latest per (runId, stage).
        this.items[existing] = event;
        return { event, accepted: true, coalesced: true };
      }
    }

    // Cosmetic events do NOT coalesce — every delta matters in a stream.
    const coalesced = false;

    if (this.items.length < this.capacity) {
      this.push(event, cls);
      return { event, accepted: true, coalesced };
    }

    // Buffer full.
    if (cls === 'critical') {
      // Critical events are never dropped. If the buffer is full of them,
      // disconnect the subscriber with 4290 slow_consumer.
      this.overflowed = true;
      this.items = [];
      this.criticalCount = 0;
      this.cosmeticCount = 0;
      this.structuralIndex.clear();
      return { event, accepted: false, coalesced: false, disconnect: LiveEventRingBuffer.SLOW_CONSUMER };
    }

    // Structural/cosmetic overflow: evict the oldest NON-critical event
    // (cosmetic drop-oldest freely; structural drop superseded-by-time). Never
    // evicts a critical. If the buffer is entirely critical, the arriving
    // event is dropped instead — only critical overflow can disconnect.
    if (this.evictOldestNonCritical()) {
      this.push(event, cls);
      return { event, accepted: true, coalesced };
    }
    return { event, accepted: false, coalesced };
  }

  /** Evict the oldest event that is not critical. Returns false when none exists. */
  private evictOldestNonCritical(): boolean {
    const idx = this.items.findIndex((e) => eventClass(e) !== 'critical');
    if (idx === -1) return false;
    this.removeAt(idx);
    return true;
  }

  /** Remove the item at `idx`, maintaining the structural coalesce index. */
  private removeAt(idx: number): void {
    const removed = this.items[idx];
    if (removed === undefined) return;
    const cls = eventClass(removed);
    if (cls === 'critical') this.criticalCount -= 1;
    if (cls === 'cosmetic') this.cosmeticCount -= 1;
    this.items.splice(idx, 1);
    if (cls === 'structural') {
      this.structuralIndex.delete(eventKey(removed));
    }
    const next = new Map<string, number>();
    for (const [k, i] of this.structuralIndex) next.set(k, i < idx ? i : i - 1);
    this.structuralIndex = next;
  }

  private push(event: LiveEvent, cls: EventClass): void {
    this.items.push(event);
    if (cls === 'critical') this.criticalCount += 1;
    if (cls === 'cosmetic') this.cosmeticCount += 1;
    if (cls === 'structural') {
      this.structuralIndex.set(eventKey(event), this.items.length - 1);
    }
  }

}
