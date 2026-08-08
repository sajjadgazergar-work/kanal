import { describe, it, expect, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { RingBuffer, RING_BUFFER_SIZE } from '../src/streams.js';
import { buildServer } from '../src/server.js';
import { FakeRunner } from './fake-runner.js';
import { sseFrame } from '../src/routes/streams.js';
import type { LiveEvent } from '@kanal/contracts';

const API_KEY = 'test-secret-key-1234567890';

function liveEvent(overrides: Partial<LiveEvent> = {}): LiveEvent {
  return {
    v: 1,
    t: 'run.state',
    runId: 'run-1',
    state: 'intake',
    at: '2026-08-08T00:00:00.000Z',
    ...overrides,
  } as LiveEvent;
}

/**
 * Collect a stream's full text. Since an SSE connection stays open by design,
 * we destroy it once we have seen the frames we care about — callers pass a
 * `done` predicate, or fall back to a short settle window.
 */
function readAll(stream: Readable, done?: (out: string) => boolean, timeoutMs = 800): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    const settle = () => {
      clearTimeout(timer);
      stream.destroy();
      resolve(out);
    };
    const timer = setTimeout(settle, timeoutMs);
    stream.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (done !== undefined && done(out)) settle();
    });
    stream.on('end', settle);
    stream.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('RingBuffer (plan §13.3–13.4)', () => {
  it('keeps events monotonic and replays since an id', () => {
    const bus = new RingBuffer();
    bus.publish(liveEvent({ state: 'intake' }));
    bus.publish(liveEvent({ state: 'briefed' }));
    const all = bus.replaySince(null);
    expect(all).toHaveLength(2);
    expect(all[0]!.id < all[1]!.id).toBe(true);

    const after = bus.replaySince(all[0]!.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.event).toMatchObject({ state: 'briefed' });
  });

  it('bounded by RING_BUFFER_SIZE', () => {
    const bus = new RingBuffer();
    for (let i = 0; i < RING_BUFFER_SIZE + 50; i++) {
      bus.publish(liveEvent({ state: 'intake' }));
    }
    expect(bus.size()).toBeLessThanOrEqual(RING_BUFFER_SIZE);
    expect(bus.replaySince(null).length).toBe(RING_BUFFER_SIZE);
  });

  it('never evicts a critical event to make room for a token (plan §13.4)', () => {
    const bus = new RingBuffer();
    // Fill with run.state (critical) events, then overflow with tokens.
    for (let i = 0; i < RING_BUFFER_SIZE; i++) {
      bus.publish(liveEvent({ state: 'intake' }));
    }
    for (let i = 0; i < 20; i++) {
      bus.publish(liveEvent({ v: 1, t: 'token', runId: 'r', stage: 's', delta: 'x' }) as LiveEvent);
    }
    const all = bus.replaySince(null);
    // The 512 critical run.state events are all preserved; the tokens were
    // dropped (at most the very first token displaced nothing critical).
    expect(all.filter((e) => e.event.t === 'run.state')).toHaveLength(RING_BUFFER_SIZE);
    expect(all.filter((e) => e.event.t === 'token').length).toBeLessThanOrEqual(1);
  });

  it('coalesces structural duplicates on overflow', () => {
    const bus = new RingBuffer();
    // 500 model.call events for the same (runId, stage), then 20 distinct
    // run.state events to force overflow.
    for (let i = 0; i < 500; i++) {
      bus.publish(
        liveEvent({ v: 1, t: 'model.call', runId: 'r', stage: 's', model: 'm', inTok: i, outTok: 0, ms: 1, costUsd: 0 }) as LiveEvent,
      );
    }
    for (let i = 0; i < 20; i++) {
      bus.publish(liveEvent({ state: 'intake' }));
    }
    const all = bus.replaySince(null);
    // All run.state events survive.
    expect(all.filter((e) => e.event.t === 'run.state')).toHaveLength(20);
    // The 500 duplicate model.call events were coalesced to a single entry.
    const modelCalls = all.filter((e) => e.event.t === 'model.call');
    expect(modelCalls.length).toBeLessThanOrEqual(1);
    expect(all.length).toBeLessThanOrEqual(RING_BUFFER_SIZE);
  });
});

describe('GET /api/v1/streams/runs (SSE)', () => {
  let bus: RingBuffer;
  let app: FastifyInstance;

  beforeEach(async () => {
    bus = new RingBuffer();
    const runner = new FakeRunner();
    app = buildServer({
      apiKey: API_KEY,
      runner,
      webhookSecrets: { async getSecret() { return null; } },
      pingDb: async () => true,
      eventBus: bus,
      logger: false,
    });
  });

  it('streams buffered events as SSE frames on connect', async () => {
    bus.publish(liveEvent({ state: 'intake' }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/streams/runs',
      headers: { authorization: `Bearer ${API_KEY}` },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const body = await readAll(res.stream(), (out) => out.includes('"run.state"'));
    expect(body).toContain('id: ');
    expect(body).toContain('data: ');
    expect(body).toContain('"run.state"');
    await app.close();
  });

  it('publishes live events to the subscriber after connect', async () => {
    const pending = app.inject({
      method: 'GET',
      url: '/api/v1/streams/runs',
      headers: { authorization: `Bearer ${API_KEY}` },
      payloadAsStream: true,
    });
    const res = await pending;
    const stream = res.stream();
    const collected = readAll(stream, (out) => out.includes('"briefed"'));
    bus.publish(liveEvent({ state: 'briefed' }));
    const body = await collected;
    expect(body).toContain('"briefed"');
    await app.close();
  });

  it('honours Last-Event-ID by replaying only newer events', async () => {
    bus.publish(liveEvent({ state: 'intake' }));
    bus.publish(liveEvent({ state: 'briefed' }));
    const first = bus.replaySince(null);
    const lastId = first[first.length - 1]!.id;

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/streams/runs',
      headers: { authorization: `Bearer ${API_KEY}`, 'last-event-id': lastId },
      payloadAsStream: true,
    });
    const body = await readAll(res.stream());
    // Nothing buffered is newer than lastId, so no run.state frames replay.
    expect(body).not.toContain('"intake"');
    expect(body).not.toContain('"briefed"');
    await app.close();
  });

  it('honours the since query param', async () => {
    bus.publish(liveEvent({ state: 'intake' }));
    const first = bus.replaySince(null)[0]!;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/streams/runs?since=${first.id}`,
      headers: { authorization: `Bearer ${API_KEY}` },
      payloadAsStream: true,
    });
    const body = await readAll(res.stream());
    expect(body).not.toContain('"intake"');
    await app.close();
  });
});

describe('sseFrame', () => {
  it('escapes newlines in the payload', () => {
    const frame = sseFrame({
      id: '00000000000000000000000000000001',
      event: { v: 1, t: 'token', runId: 'r', stage: 's', delta: 'a\nb' },
    });
    expect(frame).toBe(
      'id: 00000000000000000000000000000001\ndata: {"v":1,"t":"token","runId":"r","stage":"s","delta":"a\\nb"}\n\n',
    );
  });
});
