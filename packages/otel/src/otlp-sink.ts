/**
 * External OTLP sink (§13.1) — thin, optional, no collector required.
 *
 * `gen_ai.*` attributes and GenAI span names use the GenAI semantic-convention
 * attribute names verbatim. `kanal.*` attributes are namespaced and harmless to
 * third-party backends (Langfuse/Phoenix/Jaeger), which keep them as custom
 * attributes. Content-bearing attributes never reach the sink because the
 * allow-list processor runs first.
 *
 * This module has ZERO runtime dependency on the OpenTelemetry SDK: the types
 * below are structural definitions matching the OTel JS SDK shapes, so the
 * package builds and tests run with no collector and no transport. When an
 * app wires `@opentelemetry/sdk-trace-base` and an OTLP/gRPC exporter, the
 * `ReadableSpanForwarder` (a structural `SpanProcessor`) is accepted by the SDK
 * and forwards ended spans here.
 */

import type { LiveEvent, RunState } from '@kanal/contracts';
import { mapSpanToLiveEvent, type SpanForMapper } from './mapper.js';
import type { SpanSeed } from './taxonomy.js';

export interface OtlpSink {
  /** Forward a finished, sanitised span. */
  export(span: SpanSeed): void;
}

export type ExternalSink = OtlpSink;

export interface ExternalSinkOptions {
  /** URL of the OTLP/gRPC collector. Optional — the sink is a no-op without it. */
  endpoint?: string;
}

/**
 * The default external sink: a self-contained event sink with no transport
 * dependency. If `endpoint` is absent the sink stores the sanitised spans in
 * memory (a bounded deque) so a minimal install can self-inspect; when a real
 * OTLP/gRPC transport is added later it goes here, behind the same interface.
 */
export class SelfContainedSink implements OtlpSink {
  readonly endpoint: string | undefined;
  private readonly spans: SpanSeed[] = [];
  private readonly capacity: number;

  constructor(options: ExternalSinkOptions = {}, capacity = 1000) {
    this.endpoint = options.endpoint;
    this.capacity = capacity;
  }

  export(span: SpanSeed): void {
    if (this.endpoint !== undefined) {
      // Real transport (OTLP/gRPC via @opentelemetry/exporter-trace-otlp-grpc)
      // would marshal here. Deliberately unimplemented in the base package.
      return;
    }
    if (this.spans.length >= this.capacity) this.spans.shift();
    this.spans.push(span);
  }

  /** In-memory buffered spans (only when `endpoint` is unset). */
  snapshot(): readonly SpanSeed[] {
    return this.spans.slice();
  }

  clear(): void {
    this.spans.length = 0;
  }
}

/** Route table: which span names the bus renders. */
export function mapToLiveEvent(span: SpanForMapper): LiveEvent | null {
  return mapSpanToLiveEvent(span);
}

/** Structural `ReadableSpan` shape (OTel JS SDK). [seconds, nanoseconds]. */
export interface ReadableSpanShape {
  name: string;
  kind: number;
  startTime: [number, number];
  endTime: [number, number];
  status: { code: number; message?: string };
  attributes: Record<string, unknown>;
}

/** Structural `SpanProcessor` shape (OTel JS SDK). */
export interface SpanProcessorShape {
  onStart(span: unknown, context?: unknown): void;
  onEnd(span: ReadableSpanShape): void;
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
}

/**
 * Converts an SDK `ReadableSpan` to a `SpanSeed`. The workers export OTLP/gRPC
 * to the in-process collector, which re-forks (§13.1). Accepts either the SDK
 * shape (a tuple of seconds/nanoseconds) or an already-ms `{ ms: number }`.
 */
export function readableSpanToSeed(span: ReadableSpanShape & { ms?: number }): SpanSeed {
  const attrs: Record<string, unknown> = { ...span.attributes };
  return {
    name: span.name,
    kind: span.kind,
    attributes: attrs as Record<string, string | number | boolean | Array<string | number | boolean>>,
    startMs: span.ms ?? span.startTime[0] * 1000 + span.startTime[1] / 1_000_000,
    endMs: span.ms ?? span.endTime[0] * 1000 + span.endTime[1] / 1_000_000,
    status: span.status.code === 0 ? undefined : { code: span.status.code === 2 ? 'ERROR' : 'OK', message: span.status.message },
  };
}

/**
 * A `SpanProcessor` bridge for environments with the OpenTelemetry JS SDK:
 * converts an ended SDK span to a `SpanSeed` and forwards it to the fork
 * collector. Structural typing means the SDK's `addSpanProcessor` accepts it
 * without this package depending on `@opentelemetry/sdk-trace-base`.
 */
export class ReadableSpanForwarder implements SpanProcessorShape {
  private readonly onSpan: (span: SpanSeed) => void;

  constructor(onSpan: (span: SpanSeed) => void) {
    this.onSpan = onSpan;
  }

  onStart(): void {
    // No-op: we only forward ended spans.
  }

  onEnd(span: ReadableSpanShape): void {
    const seed = readableSpanToSeed(span as ReadableSpanShape & { ms?: number });
    this.onSpan(seed);
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

export type { RunState };
