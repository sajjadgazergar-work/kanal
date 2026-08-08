import { describe, expect, it } from 'vitest';
import {
  LiveEventRingBuffer,
  eventClass,
  RING_BUFFER_CAPACITY,
  TOKEN_THROTTLE_MS,
  COALESCE_MS,
} from '../bus.js';
import type { LiveEvent } from '@kanal/contracts';

function runState(runId: string, state: string): LiveEvent {
  return { v: 1, t: 'run.state', runId, state: state as never, at: '2026-08-08T00:00:00.000Z' };
}
function approval(runId: string): LiveEvent {
  return { v: 1, t: 'approval', runId, gate: 'publish', state: 'pending', at: '2026-08-08T00:00:00.000Z' };
}
function stageEnd(runId: string, stage: string, ok: boolean): LiveEvent {
  return { v: 1, t: 'stage.end', runId, stage, ok, ms: 10, at: '2026-08-08T00:00:00.000Z' };
}
function stageStart(runId: string, stage: string): LiveEvent {
  return { v: 1, t: 'stage.start', runId, stage, zone: 'trusted', at: '2026-08-08T00:00:00.000Z' };
}
function modelCall(runId: string, stage: string): LiveEvent {
  return { v: 1, t: 'model.call', runId, stage, model: 'm', inTok: 1, outTok: 1, ms: 5, costUsd: 0, at: '2026-08-08T00:00:00.000Z' };
}
function token(runId: string, stage: string, delta = 'x'): LiveEvent {
  return { v: 1, t: 'token', runId, stage, delta };
}
function heartbeat(): LiveEvent {
  return { v: 1, t: 'heartbeat', at: '2026-08-08T00:00:00.000Z' };
}

/** Fake monotonic clock so tests are deterministic. */
function fakeNow(): (() => number) & { advance: (ms: number) => number; set: (ms: number) => number; tick: () => number } {
  let t = 0;
  const now = (): number => t;
  Object.assign(now, { advance: (ms: number) => (t += ms), set: (ms: number) => (t = ms), tick: () => t });
  return now as never;
}

describe('drop policy (§13.4)', () => {
  it('classifies events: run.state/approval/stage.end(ok:false) critical', () => {
    expect(eventClass(runState('r', 'intake'))).toBe('critical');
    expect(eventClass(approval('r'))).toBe('critical');
    expect(eventClass(stageEnd('r', 's', false))).toBe('critical');
    expect(eventClass(stageEnd('r', 's', true))).toBe('structural');
    expect(eventClass(stageStart('r', 's'))).toBe('structural');
    expect(eventClass(modelCall('r', 's'))).toBe('structural');
    expect(eventClass(token('r', 's'))).toBe('cosmetic');
  });

  it('critical events are never dropped and overflow disconnects with 4290 slow_consumer', () => {
    const buffer = new LiveEventRingBuffer({ capacity: 3, nowMs: fakeNow() });
    expect(buffer.enqueue(runState('r', 'intake')).disconnect).toBeUndefined();
    expect(buffer.enqueue(runState('r', 'briefed')).disconnect).toBeUndefined();
    expect(buffer.enqueue(runState('r', 'sourcing')).disconnect).toBeUndefined();
    // Buffer full of critical events → disconnect, buffer reset.
    const res = buffer.enqueue(runState('r', 'researched'));
    expect(res.accepted).toBe(false);
    expect(res.disconnect).toBe('4290 slow_consumer');
    expect(buffer.isOverflowed()).toBe(true);
    expect(buffer.length).toBe(0);
  });

  it('critical events never dropped even when tokens flood', () => {
    const now = fakeNow();
    const buffer = new LiveEventRingBuffer({ capacity: 2, nowMs: now });
    // 2 critical fill the small buffer.
    buffer.enqueue(runState('r', 'intake'));
    buffer.enqueue(runState('r', 'briefed'));
    // Token floods (cosmetic) try to squeeze in — must NOT displace a critical.
    for (let i = 0; i < 5; i++) {
      now.advance(TOKEN_THROTTLE_MS + 1);
      buffer.enqueue(token('r', 'drafting', `t${i}`));
    }
    const snap = buffer.snapshot();
    expect(snap.length).toBe(2);
    expect(snap.filter((e) => e.t === 'run.state').length).toBe(2);
    expect(snap.filter((e) => e.t === 'token').length).toBe(0);
    expect(buffer.isOverflowed()).toBe(false);
  });

  it('critical events do NOT coalesce — each occupies its own slot', () => {
    const buffer = new LiveEventRingBuffer({ capacity: 3, nowMs: fakeNow() });
    buffer.enqueue(runState('r', 'intake'));
    buffer.enqueue(runState('r', 'briefed'));
    buffer.enqueue(runState('r', 'sourcing'));
    expect(buffer.length).toBe(3); // not 1
    const snap = buffer.snapshot();
    expect(snap.map((e) => (e.t === 'run.state' ? e.state : '')).join(',')).toBe('intake,briefed,sourcing');
  });

  it('structural events coalesce: keep the latest per (runId, stage)', () => {
    const buffer = new LiveEventRingBuffer({ capacity: 4, nowMs: fakeNow() });
    buffer.enqueue(stageStart('r', 'drafting'));
    buffer.enqueue(stageStart('r', 'sourcing'));
    buffer.enqueue(stageStart('r', 'drafting')); // superseded
    const snap = buffer.snapshot();
    expect(snap.length).toBe(2);
    const draftingStarts = snap.filter((e) => e.t === 'stage.start' && e.stage === 'drafting');
    expect(draftingStarts.length).toBe(1);
  });

  it('model.call coalesces per (runId, stage) keeping the latest', () => {
    const buffer = new LiveEventRingBuffer({ capacity: 4, nowMs: fakeNow() });
    buffer.enqueue(modelCall('r', 'drafting'));
    buffer.enqueue(modelCall('r', 'drafting'));
    const snap = buffer.snapshot();
    expect(snap.filter((e) => e.t === 'model.call' && e.stage === 'drafting').length).toBe(1);
  });

  it('cosmetic (token) events drop the oldest freely on overflow', () => {
    const now = fakeNow();
    const buffer = new LiveEventRingBuffer({ capacity: 3, nowMs: now });
    buffer.enqueue(token('r', 'drafting', 'a'));
    now.advance(TOKEN_THROTTLE_MS + 1);
    buffer.enqueue(token('r', 'drafting', 'b'));
    now.advance(TOKEN_THROTTLE_MS + 1);
    buffer.enqueue(token('r', 'drafting', 'c'));
    now.advance(TOKEN_THROTTLE_MS + 1);
    buffer.enqueue(token('r', 'drafting', 'd'));
    const snap = buffer.snapshot();
    expect(snap.length).toBe(3);
    expect(snap.map((e) => e.t === 'token' && e.delta).join('')).toBe('bcd');
  });

  it('coalescing and drop-oldest can coexist: an evicted key is re-added fresh', () => {
    const buffer = new LiveEventRingBuffer({ capacity: 3, nowMs: fakeNow() });
    buffer.enqueue(stageStart('r', 'a'));
    buffer.enqueue(stageStart('r', 'b'));
    buffer.enqueue(stageStart('r', 'c'));
    // Full of structural. A NEW stage must evict the oldest and free a slot.
    const res = buffer.enqueue(stageStart('r', 'd'));
    expect(res.coalesced).toBe(false);
    expect(res.accepted).toBe(true);
    expect(buffer.length).toBe(3);
    expect(buffer.snapshot().map((e) => e.stage).join(',')).toBe('b,c,d');
    // The evicted key can now be re-added fresh (no stale index).
    const again = buffer.enqueue(stageStart('r', 'a'));
    expect(again.accepted).toBe(true);
    expect(again.coalesced).toBe(false);
    expect(buffer.length).toBe(3);
  });

  it('global ceiling: 200 events/sec per subscriber via the 50 ms window', () => {
    const now = fakeNow();
    const buffer = new LiveEventRingBuffer({ capacity: 1000, nowMs: now });
    let accepted = 0;
    // 1 second simulated as 20 distinct 50ms windows, 15 attempts each.
    for (let w = 0; w < 20; w++) {
      now.set(w * COALESCE_MS + 1); // start exactly inside window `w`
      for (let i = 0; i < 15; i++) {
        if (buffer.enqueue(stageStart(`r-${w}-${i}`, `s-${i}`)).accepted) accepted += 1;
      }
    }
    expect(accepted).toBe(200); // 20 windows × 10 (the per-window budget)
    // A burst within the current window is rejected until the window rolls.
    now.set(19 * COALESCE_MS + 2); // still window 19, which is already at budget
    const burst = [0, 1, 2, 3, 4].map(() => buffer.enqueue(stageStart('r-x', 's-x')).accepted);
    expect(burst.every((a) => a === false)).toBe(true);
    now.set(20 * COALESCE_MS + 1); // roll into the next window
    expect(buffer.enqueue(stageStart('r-new', 's-new')).accepted).toBe(true);
  });

  it('token streaming throttled to 20 flushes/sec', () => {
    const now = fakeNow();
    const buffer = new LiveEventRingBuffer({ capacity: 1000, nowMs: now });
    const accepted: boolean[] = [];
    for (let i = 0; i < 100; i++) {
      now.advance(TOKEN_THROTTLE_MS + 1); // 51ms apart → 20/s
      accepted.push(buffer.enqueue(token('r', 'drafting', `t${i}`)).accepted);
    }
    expect(accepted.filter(Boolean).length).toBe(100);
    // Burst within the throttle window is dropped.
    const burst = [0, 1, 2, 3].map(() => buffer.enqueue(token('r', 'drafting', 'z')).accepted);
    expect(burst.every((a) => a === false)).toBe(true);
  });

  it('heartbeat is cosmetic and droppable', () => {
    const now = fakeNow();
    const buffer = new LiveEventRingBuffer({ capacity: 1, nowMs: now });
    buffer.enqueue(heartbeat());
    now.advance(TOKEN_THROTTLE_MS + 1);
    buffer.enqueue(heartbeat());
    expect(buffer.length).toBe(1);
  });
});

describe('ring buffer sizing', () => {
  it('default capacity is 512 events (§13.4)', () => {
    expect(RING_BUFFER_CAPACITY).toBe(512);
    const buffer = new LiveEventRingBuffer();
    expect(buffer.capacity).toBe(512);
  });

  it('critical events never dropped at default capacity', () => {
    const now = fakeNow();
    const buffer = new LiveEventRingBuffer({ nowMs: now });
    // 512 distinct critical events (distinct runIds) fill the buffer.
    for (let i = 0; i < RING_BUFFER_CAPACITY; i++) {
      now.set(Math.floor(i / 10) * COALESCE_MS + 1); // stay within the window budget
      buffer.enqueue(stageEnd(`r-${i}`, 's', false));
    }
    expect(buffer.length).toBe(RING_BUFFER_CAPACITY);
    // The 513th critical overflows — the only way to hit 4290.
    now.set(COALESCE_MS * Math.floor(RING_BUFFER_CAPACITY / 10) + 1);
    const res = buffer.enqueue(stageEnd('r-last', 's', false));
    expect(res.disconnect).toBe('4290 slow_consumer');
    expect(buffer.isOverflowed()).toBe(true);
  });

  it('stage.end ok:false is critical and can overflow a tiny buffer', () => {
    const buffer = new LiveEventRingBuffer({ capacity: 1, nowMs: fakeNow() });
    buffer.enqueue(stageEnd('r', 'a', false));
    const res = buffer.enqueue(stageEnd('r', 'b', false));
    expect(res.disconnect).toBe('4290 slow_consumer');
  });

  it('a full buffer of critical events is the only way to hit 4290', () => {
    const now = fakeNow();
    const buffer = new LiveEventRingBuffer({ capacity: 2, nowMs: now });
    buffer.enqueue(stageEnd('r', 'a', false)); // critical slot 1
    buffer.enqueue(stageEnd('r', 'b', false)); // critical slot 2
    // Now a critical arrives with the buffer full → disconnect.
    const res = buffer.enqueue(stageEnd('r', 'c', false));
    expect(res.disconnect).toBe('4290 slow_consumer');
  });
});
