import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { EventRing, LiveEventEnvelope, StreamListener } from '../streams.js';

/**
 * SSE live event stream (plan §13.3–13.4):
 *
 *   GET /api/v1/streams/runs?channelId=&since=<eventId>
 *
 * Each event is a `LiveEventEnvelope` (`{ id, event }`) serialized as an SSE
 * `id:` + `data:` pair. Reconnect uses the `Last-Event-ID` header (or the
 * `since` query param) to replay the ring buffer gap. A `ping` comment is
 * emitted every 15 s to keep intermediaries from closing the connection, and
 * backpressure is honoured by writing only when the socket can take it.
 */

const PING_INTERVAL_MS = 15_000;

/** Serialize one envelope to SSE text. */
export function sseFrame(env: LiveEventEnvelope): string {
  const payload = JSON.stringify(env.event);
  const data = payload
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n');
  return `id: ${env.id}\n${data}\n\n`;
}

export interface StreamRoutesOptions {
  /** The live event bus (a RingBuffer in production). */
  bus: EventRing;
}

export async function registerStreamRoutes(app: FastifyInstance, opts: StreamRoutesOptions): Promise<void> {
  const { bus } = opts;

  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/streams/runs',
    async (request, reply) => handleStream(request, reply, bus),
  );
}

async function handleStream(
  request: FastifyRequest<{ Querystring: Record<string, string | undefined> }>,
  reply: FastifyReply,
  bus: EventRing,
): Promise<FastifyReply> {
  const since = request.query.since ?? null;
  const lastEventId = request.headers['last-event-id'];
  const sinceId = typeof lastEventId === 'string' && lastEventId.length > 0 ? lastEventId : since;

  // Take over the response entirely; Fastify will not serialize anything else.
  reply.hijack();

  const raw = reply.raw;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const encoder = new TextEncoder();
  const write = (chunk: string): boolean => raw.write(encoder.encode(chunk));

  let closed = false;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let listener: StreamListener | null = null;

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (listener !== null) bus.unsubscribe(listener);
    if (pingTimer !== null) clearInterval(pingTimer);
    try {
      raw.end();
    } catch {
      // socket already gone
    }
  };

  // Replay the gap the client missed (plan §13.3).
  for (const env of bus.replaySince(sinceId)) {
    if (closed) break;
    if (!write(sseFrame(env))) {
      // Socket not keeping up on the very first replay — give up rather than
      // buffer in the OS indefinitely.
      close();
      return reply;
    }
  }

  listener = {
    push(env: LiveEventEnvelope): boolean {
      if (closed) return false;
      if (!write(sseFrame(env))) {
        // Slow consumer: disconnect so it reconnects and re-fetches state
        // (plan §13.4 — "4290 slow_consumer").
        close();
        return false;
      }
      return true;
    },
    disconnect(): void {
      close();
    },
  };
  bus.subscribe(listener);

  // Heartbeat (plan §13.3).
  pingTimer = setInterval(() => {
    if (closed) return;
    write(': ping\n\n');
  }, PING_INTERVAL_MS);
  pingTimer.unref?.();

  raw.on('close', () => close());
  raw.on('error', () => close());

  return reply;
}
