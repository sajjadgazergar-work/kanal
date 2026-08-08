/**
 * OTLP fork (§13.1).
 *
 * The collector interface forks sanitised spans to:
 *   (a) a span store (Postgres partitioned by day),
 *   (b) an in-memory ring buffer per run that feeds SSE,
 *   (c) optionally an external OTLP sink (Langfuse/Phoenix/Jaeger).
 *
 * The OpenTelemetry SDK never appears here; the collector consumes plain
 * span objects. `otlp-sink.ts` adapts this interface to the OTel JS SDK types
 * and is a thin stub so nothing requires a running collector in tests.
 */

import { endSeed, nowMs, type SpanSeed } from './taxonomy.js';
import { sanitizeSpan, type SanitizedSpan } from './processor.js';
import type { LiveEvent } from '@kanal/contracts';
import { mapSpanToLiveEvent } from './mapper.js';
import { LiveEventRingBuffer } from './bus.js';

/** A fully-processed span after the sanitisation pipeline has run. */
export interface ProcessedSpan {
  seed: SpanSeed;
  sanitized: SanitizedSpan;
  /** Mapped live-bus event, or null when the span does not render on the canvas. */
  event: LiveEvent | null;
}

/** Consumer of a finished, sanitised span. Must be synchronous. */
export type SpanSink = (span: ProcessedSpan) => void;

/** Consumer of a live-bus event. Must be synchronous. */
export type EventSink = (event: LiveEvent) => void;

export interface ForkSinks {
  /** The span store: persist the sanitised span (Postgres partitioned by day). */
  store: SpanSink;
  /** The live bus: push the mapped `LiveEvent` into the run's ring buffer. */
  bus: EventSink;
  /** Optional external OTLP sink (Langfuse/Phoenix/Jaeger). */
  external?: SpanSink;
}

/** Run-scoped sink factory (b): one ring buffer per run, wired to SSE fan-out. */
export type RunSinkResolver = (runId: string) => EventSink | undefined;

export interface CollectorOptions {
  fork: ForkSinks;
  /** Resolves the ring-buffer sink for a run. `undefined` → no live event for the run. */
  bus?: RunSinkResolver;
  /**
   * Only ends a span when it has both start and end timestamps. Set `false` to
   * force-end unended seeds so a live bus consumer sees them as ended.
   * @default true
   */
  requireEnd?: boolean;
  nowMs?: () => number;
}

/**
 * The in-process OTLP collector (§13.1). A worker's span arrives here, is
 * sanitised once (allow-list + content redaction + cost derivation), mapped to
 * a `LiveEvent`, then forked to the span store, the run's ring buffer, and any
 * external OTLP sink.
 */
export class OtlpForkCollector {
  private readonly fork: ForkSinks;
  private readonly bus: RunSinkResolver | undefined;
  private readonly requireEnd: boolean;
  private readonly now: () => number;

  constructor(options: CollectorOptions) {
    this.fork = options.fork;
    this.bus = options.bus;
    this.requireEnd = options.requireEnd ?? true;
    this.now = options.nowMs ?? nowMs;
  }

  /** End the span (if needed), sanitise, map, and fork. Synchronous. */
  emit(seed: SpanSeed): ProcessedSpan {
    const done: SpanSeed =
      seed.endMs !== undefined
        ? seed
        : this.requireEnd
          ? seed
          : { ...seed, endMs: this.now(), status: seed.status ?? { code: 'OK' } };
    const sanitized = sanitizeSpan(done);
    const event = mapSpanToLiveEvent(done);

    const processed: ProcessedSpan = { seed: done, sanitized, event };

    this.fork.store(processed);
    if (event !== null && this.bus !== undefined) {
      const runId = 'runId' in event ? event.runId : '';
      const sink = this.bus(runId);
      sink?.(event);
    }
    this.fork.external?.(processed);
    return processed;
  }
}

/** Convenience: a ring-buffer-per-run resolver wired to a per-run `LiveEventRingBuffer`. */
export class RingBufferStore {
  private readonly buffers = new Map<string, LiveEventRingBuffer>();
  private readonly make: (runId: string) => LiveEventRingBuffer;

  constructor(make?: (runId: string) => LiveEventRingBuffer) {
    this.make = make ?? (() => new LiveEventRingBuffer());
  }

  resolve(runId: string): LiveEventRingBuffer {
    let buffer = this.buffers.get(runId);
    if (buffer === undefined) {
      buffer = this.make(runId);
      this.buffers.set(runId, buffer);
    }
    return buffer;
  }

  sinkFor(runId: string): EventSink {
    return (event) => {
      this.resolve(runId).enqueue(event);
    };
  }

  run(runId: string): LiveEventRingBuffer | undefined {
    return this.buffers.get(runId);
  }
}

export { endSeed };
